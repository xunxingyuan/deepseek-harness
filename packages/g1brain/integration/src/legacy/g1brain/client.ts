import { Buffer } from 'node:buffer'
import type {
  AgentInfo,
  AgentInput,
  AuthTokens,
  DocumentLibrary,
  DocumentTaskSubmission,
  G1BrainConfig,
  LoginInput,
  OntologyCollection,
  OntologyDomain,
} from '../types.ts'
import { G1BrainError } from '../errors.ts'
import { encryptG1Password } from './crypto.ts'
import { requireResourceName } from '../../names.ts'

type FetchLike = typeof fetch

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function unwrap(value: unknown): unknown {
  if (isRecord(value) && 'data' in value && value.data !== undefined) {
    return value.data
  }
  return value
}

function listValue<T>(value: unknown): T[] {
  const unwrapped = unwrap(value)
  if (Array.isArray(unwrapped)) return unwrapped as T[]
  if (isRecord(unwrapped)) {
    for (const key of ['items', 'records', 'list', 'rows']) {
      if (Array.isArray(unwrapped[key])) return unwrapped[key] as T[]
    }
  }
  return []
}

function toJsonBody(value: unknown): string {
  return JSON.stringify(value)
}

function entityStatements(
  properties?: Record<string, unknown>,
  statements?: Record<string, unknown>,
): Record<string, unknown[]> {
  if (properties && statements && Object.keys(properties).length && Object.keys(statements).length) {
    throw new G1BrainError('properties 与 statements 不能同时提供；复杂属性请使用 statements')
  }
  if (statements) {
    return Object.fromEntries(Object.entries(statements).map(([propId, rows]) => {
      if (!propId.trim() || !Array.isArray(rows) || rows.some((row: unknown) => !isRecord(row) || Array.isArray(row)
        || (row.propId !== undefined && row.propId !== propId) || !isRecord(row.value) || Array.isArray(row.value)
        || typeof row.value.type !== 'string' || (!('literal' in row.value) && !('value' in row.value)))) {
        throw new G1BrainError(`statements.${propId} 必须是包含 SOValue 的语句数组`)
      }
      return [propId, rows.map((row: unknown) => {
        if (!isRecord(row)) throw new G1BrainError(`statements.${propId} 必须是对象数组`)
        return { ...row, propId: row.propId ?? propId }
      })]
    }))
  }
  return Object.fromEntries(Object.entries(properties ?? {}).map(([propId, value]) => {
    if (!propId.trim()) throw new G1BrainError('属性 SID 不能为空')
    const type = typeof value === 'string' ? 'STRING'
      : typeof value === 'boolean' ? 'BOOLEAN'
        : typeof value === 'number' && Number.isFinite(value) ? Number.isInteger(value) ? 'INTEGER' : 'DECIMAL'
          : undefined
    if (!type) throw new G1BrainError(`属性 ${propId} 的值无法安全推断类型；请改用 statements 提供 SOValue`)
    return [propId, [{ propId, value: { type, literal: value } }]]
  }))
}

function basicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`
}

function isTokenPath(path: string): boolean {
  return path.includes('/api/blade-auth/oauth/token')
}

class G1BrainClientImpl {
  private readonly config: G1BrainConfig
  private readonly fetchImpl: FetchLike
  private tokens: AuthTokens | undefined
  private refreshInFlight: Promise<AuthTokens> | undefined

  constructor(config: G1BrainConfig, fetchImpl: FetchLike = fetch) {
    this.config = config
    this.fetchImpl = fetchImpl
  }

  get baseUrl(): string {
    return this.config.baseUrl
  }

  get authState(): AuthTokens | undefined {
    return this.tokens
  }

  setTokens(tokens: AuthTokens): void {
    this.tokens = { ...tokens, issuedAt: tokens.issuedAt || Date.now() }
  }

  clearTokens(): void {
    this.tokens = undefined
    this.refreshInFlight = undefined
  }

  async login(input: LoginInput): Promise<AuthTokens> {
    const tenantId = input.tenantId ?? this.config.tenantId
    if (this.config.authMode === 'local-dev') {
      const auth: AuthTokens = {
        accessToken: 'local-dev',
        authMode: 'local-dev',
        tenantId,
        issuedAt: Date.now(),
        user: {
          account: input.username,
          username: input.username,
          userId: this.config.localUserId,
          clientId: this.config.localClientId,
        },
      }
      this.setTokens(auth)
      return auth
    }

    const form = new URLSearchParams({
      tenantId,
      username: input.username,
      password: encryptG1Password(input.password, this.config.publicKey),
      grant_type: 'password',
      scope: 'all',
      type: input.type ?? 'account',
    })
    if (input.captchaKey) form.set('key', input.captchaKey)
    if (input.captchaCode) form.set('code', input.captchaCode)

    const response = await this.fetchImpl(this.url('/api/blade-auth/oauth/token'), {
      method: 'POST',
      headers: {
        Authorization: basicAuth(this.config.clientId, this.config.clientSecret),
        'Tenant-Id': tenantId,
        'User-Type': 'app',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    })
    const body = await this.readBody(response)
    if (!response.ok) {
      throw new G1BrainError(this.errorMessage(body, 'G1brain 登录失败'), {
        status: response.status,
        path: '/api/blade-auth/oauth/token',
        response: body,
      })
    }

    const token = unwrap(body)
    if (!isRecord(token) || typeof token.access_token !== 'string' || token.access_token === '') {
      throw new G1BrainError(this.errorMessage(body, 'G1brain 未返回 access_token'), {
        status: response.status,
        path: '/api/blade-auth/oauth/token',
        response: body,
      })
    }
    const accessToken = token.access_token

    const auth: AuthTokens = {
      accessToken,
      authMode: 'oauth',
      ...(typeof token.refresh_token === 'string' ? { refreshToken: token.refresh_token } : {}),
      tenantId: typeof token.tenant_id === 'string' ? token.tenant_id : tenantId,
      ...(typeof token.expires_in === 'number' ? { expiresIn: token.expires_in } : {}),
      issuedAt: Date.now(),
      ...(isRecord(token.user) ? { user: token.user } : {}),
    }
    this.setTokens(auth)
    return auth
  }

  async refresh(): Promise<AuthTokens> {
    if (this.config.authMode === 'local-dev') {
      if (!this.tokens) throw new G1BrainError('当前会话没有登录态')
      return this.tokens
    }

    const refreshToken = this.tokens?.refreshToken
    if (!refreshToken) throw new G1BrainError('当前会话没有 refresh_token')
    if (this.refreshInFlight) return this.refreshInFlight

    this.refreshInFlight = (async () => {
      const tenantId = this.tokens?.tenantId ?? this.config.tenantId
      const form = new URLSearchParams({
        tenantId,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        scope: 'all',
      })
      const response = await this.fetchImpl(this.url('/api/blade-auth/oauth/token'), {
        method: 'POST',
        headers: {
          Authorization: basicAuth(this.config.clientId, this.config.clientSecret),
          'Tenant-Id': tenantId,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      })
      const body = await this.readBody(response)
      if (!response.ok) {
        this.clearTokens()
        throw new G1BrainError(this.errorMessage(body, 'G1brain Token 刷新失败'), {
          status: response.status,
          path: '/api/blade-auth/oauth/token',
          response: body,
        })
      }
      const token = unwrap(body)
      if (!isRecord(token) || typeof token.access_token !== 'string' || token.access_token === '') {
        this.clearTokens()
        throw new G1BrainError('G1brain Token 刷新响应无 access_token', { response: body })
      }
      const accessToken = token.access_token
      const refreshed: AuthTokens = {
        accessToken,
        ...(typeof token.refresh_token === 'string'
          ? { refreshToken: token.refresh_token }
          : { refreshToken }),
        tenantId: typeof token.tenant_id === 'string' ? token.tenant_id : tenantId,
        ...(typeof token.expires_in === 'number' ? { expiresIn: token.expires_in } : {}),
        issuedAt: Date.now(),
      }
      this.setTokens(refreshed)
      return refreshed
    })()

    try {
      return await this.refreshInFlight
    } finally {
      this.refreshInFlight = undefined
    }
  }

  async listMdLibraries(): Promise<DocumentLibrary[]> {
    return listValue<DocumentLibrary>(await this.request('/mdApi/v1/md/collections'))
  }

  async createMdLibrary(name: string): Promise<unknown> {
    return this.request(`/mdApi/v1/md/collections?name=${encodeURIComponent(name)}`, {
      method: 'POST',
    })
  }

  async listMdDocuments(collectionName: string): Promise<unknown[]> {
    return listValue<unknown>(await this.request(`/mdApi/v1/md/collections/${encodeURIComponent(collectionName)}/all`))
  }

  async uploadMdFile(collectionName: string, fileName: string, contents: Uint8Array | string): Promise<unknown> {
    const form = new FormData()
    const bytes = typeof contents === 'string' ? new TextEncoder().encode(contents) : contents
    const file = new File([bytes as BlobPart], fileName, { type: typeof contents === 'string' ? 'text/markdown; charset=utf-8' : 'application/octet-stream' })
    form.append('file', file)
    return this.request(`/mdApi/v1/md/collections/${encodeURIComponent(collectionName)}/mds`, {
      method: 'POST',
      body: form,
    })
  }

  async submitMdTask(collectionName: string, submission: DocumentTaskSubmission): Promise<unknown> {
    return this.request(`/mdApi/v1/md/collections/${encodeURIComponent(collectionName)}/tasks/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: toJsonBody(submission),
    })
  }

  async listMdTasks(collectionName: string): Promise<unknown[]> {
    return listValue<unknown>(await this.request(`/mdApi/v1/md/collections/${encodeURIComponent(collectionName)}/tasks`))
  }

  async listMdTaskHistory(collectionName: string): Promise<unknown[]> {
    return listValue<unknown>(await this.request(`/mdApi/v1/md/collections/${encodeURIComponent(collectionName)}/tasks/history`))
  }

  async getMdTask(collectionName: string, taskId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(`/mdApi/v1/md/collections/${encodeURIComponent(collectionName)}/tasks/${encodeURIComponent(taskId)}`,
      signal === undefined ? {} : { signal })
  }

  async getMdTaskFileStatuses(collectionName: string, taskId: string): Promise<unknown> {
    return this.request(`/mdApi/v1/md/collections/${encodeURIComponent(collectionName)}/tasks/${encodeURIComponent(taskId)}/status`)
  }

  async cancelMdTask(collectionName: string, taskId: string): Promise<unknown> {
    return this.request(`/mdApi/v1/md/collections/${encodeURIComponent(collectionName)}/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: 'POST',
    })
  }

  async hybridSearch(collectionName: string, query: string): Promise<unknown> {
    return this.request(`/mdApi/v1/md/collections/${encodeURIComponent(collectionName)}/indexes/hybridSearch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: toJsonBody({ query }),
    })
  }

  async listOntologyCollections(): Promise<OntologyCollection[]> {
    return listValue<OntologyCollection>(await this.request('/kgApi/v1/gs/collections'))
  }

  async createOntologyCollection(name: string, description = '', displayName?: string): Promise<unknown> {
    requireResourceName(name)
    const result = await this.request('/kgApi/v1/gs/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, ...(displayName === undefined ? {} : { attributes: { displayName } }) }),
    })
    const created = unwrap(result)
    if (isRecord(created) && typeof created.name === 'string' && created.name !== name) {
      throw new Error('G1brain returned a different collection API name; do not write child records using the requested name')
    }
    if (displayName !== undefined) {
      const attributes = isRecord(created) && isRecord(created.attributes) ? created.attributes
        : unwrap(await this.request(`/kgApi/v1/gs/collections/${encodeURIComponent(name)}/attributes`))
      if (!isRecord(attributes) || attributes.displayName !== displayName) throw new Error('G1brain collection was created but its display name could not be verified')
    }
    return result
  }

  async listOntologyDomains(collectionName: string): Promise<OntologyDomain[]> {
    const items = listValue<OntologyDomain | string>(
      await this.request(`/kgApi/v1/gs/collections/${encodeURIComponent(collectionName)}/domains?view=detail`),
    )
    return items.map(item => typeof item === 'string' ? { name: item } : item)
  }

  async createOntologyDomain(collectionName: string, name: string, displayName?: string): Promise<unknown> {
    requireResourceName(name)
    const path = `/kgApi/v1/gs/collections/${encodeURIComponent(collectionName)}/domains`
    const result = await this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (displayName !== undefined) {
      const configPath = `${path}/${encodeURIComponent(name)}/config`
      await this.request(configPath, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName }) })
      const saved = unwrap(await this.request(configPath))
      if (!isRecord(saved) || saved.displayName !== displayName) throw new Error('G1brain domain was created but its display name could not be verified')
    }
    return result
  }

  async validateOntologyPackage(packageJson: unknown): Promise<unknown> {
    return this.request('/kgApi/v1/gs/ontology-package/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: toJsonBody(packageJson),
    })
  }

  async importOntologyPackage(collectionName: string, packageJson: unknown, replace = false): Promise<unknown> {
    const query = new URLSearchParams({ replace: String(replace), dryRun: 'false' }).toString()
    return this.request(`/kgApi/v1/gs/collections/${encodeURIComponent(collectionName)}/packages/imports?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: toJsonBody(packageJson),
    })
  }

  // --- P0: Ontology Query, Detail, Relations & Export ---

  async queryOntologyEntities(
    collectionName: string,
    domainName: string,
    keyword?: string,
    page = 1,
    size = 50,
  ): Promise<unknown> {
    const c = encodeURIComponent(collectionName)
    const d = encodeURIComponent(domainName)
    if (keyword && keyword.trim()) {
      const q = encodeURIComponent(keyword.trim())
      return this.request(`/kgApi/v1/gs/collections/${c}/domains/${d}/entities/matches?q=${q}`)
    }
    const params = new URLSearchParams({ page: String(page), size: String(size) })
    return this.request(`/kgApi/v1/gs/collections/${c}/domains/${d}/entities?${params}`)
  }

  async getOntologyEntityDetail(
    collectionName: string,
    domainName: string,
    entitySid: string,
  ): Promise<{ detail: unknown; effectiveProperties?: unknown; instances?: unknown; warnings?: string[] }> {
    const c = encodeURIComponent(collectionName)
    const d = encodeURIComponent(domainName)
    const sid = encodeURIComponent(entitySid)
    const detail = await this.request(`/kgApi/v1/gs/collections/${c}/domains/${d}/entities/${sid}`)
    const [effectiveProperties, instances] = await Promise.allSettled([
      this.request(`/kgApi/v1/gs/collections/${c}/domains/${d}/entities/${sid}/effective-properties`),
      this.request(`/kgApi/v1/gs/collections/${c}/domains/${d}/entities/${sid}/instances`),
    ])
    const warnings = [
      ...(effectiveProperties.status === 'rejected' ? [`有效属性读取失败：${String(effectiveProperties.reason)}`] : []),
      ...(instances.status === 'rejected' ? [`实例读取失败：${String(instances.reason)}`] : []),
    ]
    return {
      detail,
      effectiveProperties: effectiveProperties.status === 'fulfilled' ? effectiveProperties.value : undefined,
      instances: instances.status === 'fulfilled' ? instances.value : undefined,
      ...(warnings.length ? { warnings } : {}),
    }
  }

  async getOntologyRelations(
    collectionName: string,
    domainName: string,
    entitySid?: string,
    direction = 'both',
    page = 1,
    size = 200,
  ): Promise<unknown> {
    const c = encodeURIComponent(collectionName)
    const d = encodeURIComponent(domainName)
    if (entitySid && entitySid.trim()) {
      const sid = encodeURIComponent(entitySid.trim())
      return this.request(
        `/kgApi/v1/gs/collections/${c}/domains/${d}/relations/by-sid/${sid}?direction=${encodeURIComponent(direction)}`,
      )
    }
    return this.request(`/kgApi/v1/gs/collections/${c}/domains/${d}/relations?page=${page}&size=${size}`)
  }

  async exportOntologyPackage(collectionName: string, domains?: string[], mode = 'full'): Promise<unknown> {
    const c = encodeURIComponent(collectionName)
    const params = new URLSearchParams({ mode })
    if (Array.isArray(domains)) {
      for (const dom of domains) params.append('domains', dom)
    }
    return this.request(`/kgApi/v1/gs/collections/${c}/packages/export-files?${params}`)
  }

  // --- P1: Fine-Grained Entity, Relation & Property Operations ---

  async createOntologyEntity(
    collectionName: string,
    domainName: string,
    data: {
      sid: string
      displayName: string
      isClass?: boolean | undefined
      parentClassSid?: string | undefined
      instanceOf?: string[] | undefined
      description?: string | undefined
      properties?: Record<string, unknown> | undefined
      statements?: Record<string, unknown> | undefined
      treeId?: string | undefined
    },
  ): Promise<unknown> {
    const c = encodeURIComponent(collectionName)
    const d = encodeURIComponent(domainName)
    const statements = entityStatements(data.properties, data.statements)
    let treeId = data.treeId
    if (!treeId) {
      const nodes = listValue<{ id: string }>(
        await this.request(`/kgApi/v1/gs/collections/${c}/domains/${d}/entity-taxonomy/nodes`),
      )
      if (!nodes[0]?.id) throw new G1BrainError('无法确定本体分类树节点；请显式提供 treeId')
      treeId = nodes[0].id
    }
    const isClass = data.isClass ?? !(data.instanceOf?.length)
    const payload: Record<string, unknown> = {
      sid: data.sid,
      displayName: data.displayName,
      isClass,
      isInstance: !isClass,
      path: '/',
      description: data.description ?? '',
      labels: { zh: { lang: 'zh', value: data.displayName } },
      statements,
    }
    if (data.parentClassSid) {
      payload.primarySubclassOf = data.parentClassSid
    }
    if (Array.isArray(data.instanceOf)) {
      payload.instanceOf = data.instanceOf
    }
    return this.request(
      `/kgApi/v1/gs/collections/${c}/domains/${d}/entity-taxonomy/nodes/${encodeURIComponent(treeId)}/entities`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    )
  }

  async updateOntologyEntity(
    collectionName: string,
    domainName: string,
    entitySid: string,
    properties: Record<string, unknown>,
    incremental = true,
  ): Promise<unknown> {
    const c = encodeURIComponent(collectionName)
    const d = encodeURIComponent(domainName)
    const sid = encodeURIComponent(entitySid)
    return this.request(`/kgApi/v1/gs/collections/${c}/domains/${d}/entities/${sid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties, incremental }),
    })
  }

  async createOntologyRelation(
    collectionName: string,
    domainName: string,
    data: {
      fromSid: string
      toSid: string
      relationSid: string
      properties?: Record<string, unknown> | undefined
    },
  ): Promise<unknown> {
    const c = encodeURIComponent(collectionName)
    const d = encodeURIComponent(domainName)
    const payload = {
      fromSid: data.fromSid,
      toSid: data.toSid,
      relationSid: data.relationSid,
      properties: data.properties ?? {},
    }
    return this.request(`/kgApi/v1/gs/collections/${c}/domains/${d}/relations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }

  async deleteOntologyRelation(
    collectionName: string,
    domainName: string,
    relationId: string,
  ): Promise<unknown> {
    const c = encodeURIComponent(collectionName)
    const d = encodeURIComponent(domainName)
    const rId = encodeURIComponent(relationId)
    return this.request(`/kgApi/v1/gs/collections/${c}/domains/${d}/relations/${rId}`, {
      method: 'DELETE',
    })
  }

  async listOntologyProperties(
    collectionName: string,
    domainName: string,
    page = 1,
    size = 100,
  ): Promise<unknown> {
    const c = encodeURIComponent(collectionName)
    const d = encodeURIComponent(domainName)
    const params = new URLSearchParams({ page: String(page), size: String(size) })
    return this.request(`/kgApi/v1/gs/collections/${c}/domains/${d}/props?${params}`)
  }

  async listEntityTaxonomyNodes(collectionName: string, domainName: string): Promise<unknown> {
    return this.request(`/kgApi/v1/gs/collections/${encodeURIComponent(collectionName)}/domains/${encodeURIComponent(domainName)}/entity-taxonomy/nodes`)
  }

  async listEffectiveRelationDefinitions(collectionName: string, domainName: string): Promise<unknown> {
    return this.request(`/kgApi/v1/gs/collections/${encodeURIComponent(collectionName)}/domains/${encodeURIComponent(domainName)}/schema/relations/effective`)
  }

  async listOntologyRelationTypes(collectionName: string, domainName: string, page = 1, size = 20): Promise<unknown> {
    return this.request(`/kgApi/v1/gs/collections/${encodeURIComponent(collectionName)}/domains/${encodeURIComponent(domainName)}/relation-types?page=${page}&size=${size}`)
  }

  async getOntologyRelationType(collectionName: string, domainName: string, relationSid: string): Promise<unknown> {
    return this.request(`/kgApi/v1/gs/collections/${encodeURIComponent(collectionName)}/domains/${encodeURIComponent(domainName)}/relation-types/${encodeURIComponent(relationSid)}`)
  }

  async createOntologyRelationType(collectionName: string, domainName: string, data: Record<string, unknown>): Promise<unknown> {
    return this.request(`/kgApi/v1/gs/collections/${encodeURIComponent(collectionName)}/domains/${encodeURIComponent(domainName)}/relation-types`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    })
  }

  async updateOntologyRelationType(
    collectionName: string, domainName: string, relationSid: string,
    properties: Record<string, unknown>, incremental = true,
  ): Promise<unknown> {
    const path = `/kgApi/v1/gs/collections/${encodeURIComponent(collectionName)}/domains/${encodeURIComponent(domainName)}`
    return this.request(`${path}/relation-types/${encodeURIComponent(relationSid)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ properties, incremental }),
    })
  }

  async renameOntologyRelationType(
    collectionName: string, domainName: string, relationSid: string, newDisplayName: string,
  ): Promise<unknown> {
    const path = `/kgApi/v1/gs/collections/${encodeURIComponent(collectionName)}/domains/${encodeURIComponent(domainName)}`
    return this.request(`${path}/relation-types/${encodeURIComponent(relationSid)}/rename-label`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newDisplayName }),
    })
  }

  async deleteOntologyRelationType(collectionName: string, domainName: string, relationSid: string): Promise<unknown> {
    return this.request(`/kgApi/v1/gs/collections/${encodeURIComponent(collectionName)}/domains/${encodeURIComponent(domainName)}/relation-types/${encodeURIComponent(relationSid)}?cascade=false`, {
      method: 'DELETE',
    })
  }

  async deleteOntologyEntity(collectionName: string, domainName: string, nodeId: string, expectedSid: string): Promise<unknown> {
    if (!/^[1-9]\d*$/.test(nodeId)) throw new G1BrainError('nodeId 必须是正整数字符串')
    const path = `/kgApi/v1/gs/collections/${encodeURIComponent(collectionName)}/domains/${encodeURIComponent(domainName)}/nodes/${encodeURIComponent(nodeId)}`
    const entity = await this.request<{ id?: string | number; sid?: string }>(path)
    if (String(entity.id) !== nodeId || entity.sid !== expectedSid) {
      throw new G1BrainError('节点 ID 与预期实体 SID 不一致，已取消删除')
    }
    return this.request(path, { method: 'DELETE' })
  }

  async createOntologyProperty(collectionName: string, domainName: string, data: Record<string, unknown>): Promise<unknown> {
    return this.request(`/kgApi/v1/gs/collections/${encodeURIComponent(collectionName)}/domains/${encodeURIComponent(domainName)}/props`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    })
  }

  async updateOntologyProperty(
    collectionName: string, domainName: string, propertySid: string,
    properties: Record<string, unknown>, incremental = true,
  ): Promise<unknown> {
    const path = `/kgApi/v1/gs/collections/${encodeURIComponent(collectionName)}/domains/${encodeURIComponent(domainName)}`
    return this.request(`${path}/props/by-sid/${encodeURIComponent(propertySid)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ properties, incremental }),
    })
  }

  async deleteOntologyProperty(collectionName: string, domainName: string, nodeId: string): Promise<unknown> {
    return this.request(`/kgApi/v1/gs/collections/${encodeURIComponent(collectionName)}/domains/${encodeURIComponent(domainName)}/props/${encodeURIComponent(nodeId)}?cascade=false`, {
      method: 'DELETE',
    })
  }

  async updateOntologyRelation(
    collectionName: string, domainName: string, relationId: string,
    properties: Record<string, unknown>, incremental = true,
  ): Promise<unknown> {
    const path = `/kgApi/v1/gs/collections/${encodeURIComponent(collectionName)}/domains/${encodeURIComponent(domainName)}`
    return this.request(`${path}/relations/${encodeURIComponent(relationId)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ properties, incremental }),
    })
  }

  // --- P2: Document Locating & QA ---

  async locateDocumentChunks(
    collectionName: string,
    fileName: string,
    text?: string,
    headings?: string[],
  ): Promise<unknown> {
    const c = encodeURIComponent(collectionName)
    if (Array.isArray(headings) && headings.length > 0) {
      return this.request(`/mdApi/v1/md/collections/${c}/mds/locateByHeadings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName, headings }),
      })
    }
    return this.request(`/mdApi/v1/md/collections/${c}/mds/locate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, text: text ?? '' }),
    })
  }

  async listDocumentChunks(collectionName: string): Promise<unknown> {
    const c = encodeURIComponent(collectionName)
    return this.request(`/mdApi/v1/md/collections/${c}/chunks`)
  }

  async qaSearch(collectionName: string, query: string): Promise<unknown> {
    const c = encodeURIComponent(collectionName)
    return this.request(`/mdApi/v1/qa/collections/${c}/indexes/hybridSearch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    })
  }

  async listAgents(): Promise<AgentInfo[]> {
    return listValue<AgentInfo>(await this.request('/api/giant-wiki/agent-info'))
  }

  async getAgent(id: string): Promise<AgentInfo> {
    return unwrap(await this.request(`/api/giant-wiki/agent-info/${encodeURIComponent(id)}`)) as AgentInfo
  }

  async createAgent(data: AgentInput): Promise<unknown> {
    const payload: Record<string, unknown> = { ...data }
    const prompt = data.prompt ?? data.promptTemplate
    if (prompt !== undefined) {
      payload.prompt = prompt
      payload.promptTemplate = prompt
    }
    const model = data.model ?? data.modelId
    if (model !== undefined) {
      payload.model = model
      payload.modelId = model
    }
    return this.request('/api/giant-wiki/agent-info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: toJsonBody(payload),
    })
  }

  async updateAgent(id: string, data: Partial<AgentInput>): Promise<unknown> {
    const payload: Record<string, unknown> = { id, ...data }
    const prompt = data.prompt ?? data.promptTemplate
    if (prompt !== undefined) {
      payload.prompt = prompt
      payload.promptTemplate = prompt
    }
    const model = data.model ?? data.modelId
    if (model !== undefined) {
      payload.model = model
      payload.modelId = model
    }
    return this.request(`/api/giant-wiki/agent-info/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: toJsonBody(payload),
    })
  }

  async publishAgent(id: string): Promise<unknown> {
    return this.request(`/api/giant-wiki/agent-info/${encodeURIComponent(id)}/publish`, { method: 'POST' })
  }

  private url(path: string): string {
    return `${this.config.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
  }

  private async request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
    const headers = new Headers(init.headers)
    if (this.config.authMode === 'local-dev') {
      headers.set('X-User-Id', this.config.localUserId)
      headers.set('X-Client-Id', this.config.localClientId)
    } else {
      headers.set('Authorization', basicAuth(this.config.clientId, this.config.clientSecret))
      if (this.tokens?.accessToken) headers.set('Blade-Auth', `bearer ${this.tokens.accessToken}`)
    }
    if (!headers.has('Accept')) headers.set('Accept', 'application/json')

    const timeout = new AbortController()
    const timeoutId = setTimeout(() => { timeout.abort(new Error('G1brain 请求超时')) }, this.config.timeoutMs)
    const signal = init.signal ? AbortSignal.any([timeout.signal, init.signal]) : timeout.signal

    try {
      const response = await this.fetchImpl(this.url(path), { ...init, headers, signal, redirect: 'error' })
      const body = await this.readBody(response)
      if (response.status === 401 && retry && !isTokenPath(path) && this.tokens?.refreshToken) {
        await this.refresh()
        return await this.request<T>(path, init, false)
      }
      if (!response.ok) {
        throw new G1BrainError(this.errorMessage(body, `G1brain 请求失败：${path}`), {
          status: response.status,
          path,
          response: body,
        })
      }
      if (isRecord(body) && typeof body.code === 'number' && body.code >= 400) {
        throw new G1BrainError(this.errorMessage(body, `G1brain 业务请求失败：${path}`), {
          status: body.code,
          path,
          response: body,
        })
      }
      return unwrap(body) as T
    } finally {
      clearTimeout(timeoutId)
    }
  }

  private async readBody(response: Response): Promise<unknown> {
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      try {
        return await response.json()
      } catch {
        return undefined
      }
    }
    const text = await response.text()
    if (!text) return undefined
    try {
      const value: unknown = JSON.parse(text)
      return value
    } catch {
      return text
    }
  }

  private errorMessage(body: unknown, fallback: string): string {
    if (isRecord(body)) {
      for (const key of ['error_description', 'message', 'msg', 'error']) {
        if (typeof body[key] === 'string' && body[key]) return body[key]
      }
      if (isRecord(body.data)) {
        for (const key of ['message', 'msg', 'error']) {
          if (typeof body.data[key] === 'string' && body.data[key]) return body.data[key]
        }
      }
    }
    return fallback
  }
}

/** Host-only REST client type for the imported G1brain tool definitions. */
export type G1BrainClient = G1BrainClientImpl

/** Create a G1brain REST client without exposing its transport implementation.
 * @param config - resolved service and authentication settings.
 * @param fetchImpl - optional HTTP implementation for tests.
 * @returns a client with the legacy ontology and document operations.
 */
export function createG1BrainClient(config: G1BrainConfig, fetchImpl: FetchLike = fetch): G1BrainClient {
  return new G1BrainClientImpl(config, fetchImpl)
}
