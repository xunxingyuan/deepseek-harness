/** G1brain catalog access for the desktop workbench and read-only agent tools. */

import { Buffer } from 'node:buffer'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool, type ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import { createBindingStore } from './bindings.ts'
import { assertTaskScope, DELETION_TOOLS, MUTATING_TOOLS, requiresDeletionApproval, scopedSchema } from './legacy/bridge/policy.ts'
import { openWorkspaceScope } from './legacy/bridge/scope.ts'
import { createG1BrainTools } from './legacy/bridge/tools.ts'
import { validateInput } from './legacy/bridge/validate.ts'
import { createG1BrainClient, type G1BrainClient } from './legacy/g1brain/client.ts'
import type { PreparedTask } from './legacy/types.ts'
import { toHarnessToolSchema } from './tool-schema.ts'
import type { G1brainBindReceipt, G1brainBindRequest, G1brainCatalogItem, G1brainStatus } from './types.ts'

export type { G1brainBindReceipt, G1brainBindRequest, G1brainCatalogItem, G1brainSessionTarget, G1brainStatus } from './types.ts'

const AGENT_MANAGEMENT_TOOLS = new Set([
  'g1brain_list_agents', 'g1brain_get_agent', 'g1brain_create_agent',
  'g1brain_update_agent', 'g1brain_publish_agent',
])

const GLOBAL_READ_TOOLS = new Set([
  'g1brain_list_ontology_domains',
  'g1brain_list_entity_taxonomy_nodes',
  'g1brain_list_ontology_properties',
  'g1brain_list_ontology_relation_definitions',
  'g1brain_list_ontology_relation_types',
  'g1brain_get_ontology_relation_type',
  'g1brain_query_ontology_entities',
  'g1brain_get_ontology_entity_detail',
  'g1brain_get_ontology_relations',
  'g1brain_list_documents',
  'g1brain_hybrid_search',
  'g1brain_locate_document_chunks',
  'g1brain_list_document_chunks',
  'g1brain_qa_search',
])
const GLOBAL_READ_RESULT_BYTES = 32 * 1024

const WORKFLOW_GUIDANCE = [
  '## G1brain workflow',
  'Reply in the language of the current user request, including progress updates, clarification questions, and the final result. Use Simplified Chinese for Chinese requests unless the user explicitly asks for another language.',
  'Use the available G1brain tools for ontology and document operations. Ordinary Sessions provide discovery and search; creation and updates require a G1brain build or improvement Session prepared with the selected ontology, domain, document library, and source folder.',
  'If write tools are absent, explain that this Session is read-only and direct the user to prepare a G1brain build or improvement Session. Do not interpret missing write tools as missing API credentials or ask the user to install another plugin.',
  'Use g1brain_read_selected_file to extract DOCX or Excel text and tables, not a raw text read of Office bytes. Upload tools extract UTF-8 Markdown before ingestion. Unsupported or encrypted files must be converted first; never upload garbled text as a successful extraction. Document uploads and processing tasks use the document library API name from the Session context, not the ontology collection name or a display name.',
  'In a prepared Session, inspect the sources and cite evidence. Execute requested creation, updates, uploads, and document processing within the bound resources without asking for extra confirmation. A request only for information or a plan is not a request to write data. Ask clarification questions only when the intended scope or business requirement is ambiguous.',
  'Deletion and replacement imports that may remove existing content require approval for each call. Set confirm=true for those calls and let Harness request approval; do not ask for a separate chat confirmation. Missing or rejected approval must prevent the deletion.',
].join('\n\n')

/** Deployment settings; credentials stay in the Host process. */
export interface Config {
  /** G1brain HTTP(S) service root; empty keeps the plugin active but unconfigured. */
  readonly baseUrl: string
  /** OAuth Basic-auth client id. */
  readonly clientId: string
  /** Tenant header for catalog reads. */
  readonly tenantId: string
  /** Maximum duration of one catalog request in milliseconds. */
  readonly timeoutMs: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function displayNameOf(item: Record<string, unknown>): string | undefined {
  const attributes = isRecord(item.attributes) ? item.attributes : undefined
  const extra = isRecord(item.extra) ? item.extra : undefined
  for (const value of [item.displayName, attributes?.displayName, extra?.displayName, item.label]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function itemsOf(value: unknown): G1brainCatalogItem[] {
  const data: unknown = isRecord(value) && value.data !== undefined ? value.data : value
  let list: readonly unknown[] | undefined
  if (Array.isArray(data)) list = data
  else if (isRecord(data)) {
    for (const key of ['items', 'records', 'list', 'rows']) {
      const candidate = data[key]
      if (Array.isArray(candidate)) { list = candidate; break }
    }
  }
  if (list === undefined) throw new Error('G1brain returned an invalid catalog response')
  return list.flatMap((item) => {
    if (typeof item === 'string' && item.trim()) return [{ name: item }]
    if (isRecord(item) && typeof item.name === 'string' && item.name.trim()) {
      const name = item.name.trim()
      const displayName = displayNameOf(item)
      return [{ name, ...(displayName && displayName !== name ? { displayName } : {}) }]
    }
    return []
  })
}

/** Host-only Remote service. No bearer token is exposed to the Client. */
export default class G1brainIntegration extends TypertRemoteService {
  static inject = ['tools', 'sessions', 'agents', 'approval', 'systemPrompt']

  static Config: z<Partial<Config>, Config> = z.object({
    baseUrl: z.string().default(''),
    clientId: z.string().default('lhzstp'),
    tenantId: z.string().default('000000'),
    timeoutMs: z.natural().min(1).default(15000),
  })

  private readonly endpoint: URL | undefined
  private readonly authentication: Readonly<Record<string, string>> | undefined
  private readonly mode: G1brainStatus['mode']
  private readonly bindings = createBindingStore(join(resolveDshHome(), 'g1brain', 'bindings'))
  private readonly installed = new WeakSet<Agent>()
  private readonly attaching = new WeakMap<Agent, Promise<void>>()
  private readonly writesEnabled: boolean
  private readonly client: G1BrainClient | undefined

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'g1brain')
    const env = process.env
    this.mode = env.G1BRAIN_AUTH_MODE === 'oauth' ? 'oauth' : 'local-dev'
    this.writesEnabled = this.mode === 'oauth' || env.G1BRAIN_ALLOW_DEV_WRITES === '1'
    if (this.mode === 'oauth') {
      const token = env.G1BRAIN_ACCESS_TOKEN?.trim()
      const secret = env.G1BRAIN_CLIENT_SECRET?.trim()
      if (token && secret) this.authentication = {
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${secret}`, 'utf8').toString('base64')}`,
        'Blade-Auth': `bearer ${token}`,
      }
    } else if (env.G1BRAIN_ALLOW_LOCAL_DEV === '1') {
      const userId = env.G1BRAIN_LOCAL_USER_ID?.trim()
      const clientId = env.G1BRAIN_LOCAL_CLIENT_ID?.trim()
      if (userId && clientId) this.authentication = { 'X-User-Id': userId, 'X-Client-Id': clientId }
    }
    if (config.baseUrl && this.authentication !== undefined) {
      const endpoint = new URL(config.baseUrl)
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new Error('G1brain baseUrl must be an HTTP(S) origin or path without credentials, query, or fragment')
      }
      this.endpoint = new URL(endpoint.href.endsWith('/') ? endpoint.href : `${endpoint.href}/`)
    }
    this.client = this.endpoint === undefined ? undefined : createG1BrainClient({
      baseUrl: this.endpoint.href.replace(/\/$/u, ''),
      authMode: this.mode,
      clientId: config.clientId,
      clientSecret: env.G1BRAIN_CLIENT_SECRET?.trim() ?? '',
      tenantId: config.tenantId,
      publicKey: env.G1BRAIN_PUBLIC_KEY?.trim() ?? '',
      timeoutMs: config.timeoutMs,
      localUserId: env.G1BRAIN_LOCAL_USER_ID?.trim() ?? '',
      localClientId: env.G1BRAIN_LOCAL_CLIENT_ID?.trim() ?? '',
    })
    if (this.client !== undefined && this.mode === 'oauth') {
      const accessToken = env.G1BRAIN_ACCESS_TOKEN?.trim()
      if (accessToken) this.client.setTokens({
        accessToken, tenantId: config.tenantId, issuedAt: Date.now(),
        ...(env.G1BRAIN_REFRESH_TOKEN ? { refreshToken: env.G1BRAIN_REFRESH_TOKEN } : {}),
      })
    }
    if (this.endpoint === undefined) return
    ctx.systemPrompt.section({
      name: 'g1brain:workflow',
      order: ctx.systemPrompt.getSectionOrder('MCP_SERVERS'),
      text: WORKFLOW_GUIDANCE,
    })
    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'g1brain_list_ontology_collections',
      description: 'List G1brain ontology collections available to the current desktop configuration.',
      parameters: {},
      output: { schema: { type: 'array', items: { type: 'object', properties: { name: { type: 'string', required: true } }, additionalProperties: false } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (_args, execution) => (await this.listOntologyCollections(execution.signal)).map(({ name }) => ({ name })),
    })), 'g1brain: ontology collections tool')
    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'g1brain_list_document_libraries',
      description: 'List G1brain document libraries available to the current desktop configuration.',
      parameters: {},
      output: { schema: { type: 'array', items: { type: 'object', properties: { name: { type: 'string', required: true } }, additionalProperties: false } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (_args, execution) => (await this.listDocumentLibraries(execution.signal)).map(({ name }) => ({ name })),
    })), 'g1brain: document libraries tool')
    if (this.client !== undefined) {
      const reads = createG1BrainTools({ client: this.client }).filter(tool => GLOBAL_READ_TOOLS.has(tool.name))
      if (reads.length !== GLOBAL_READ_TOOLS.size) throw new Error('G1brain global read tool inventory is incomplete')
      for (const tool of reads) {
        if (MUTATING_TOOLS.has(tool.name)) throw new Error(`G1brain global tool is mutating: ${tool.name}`)
        const parameters = toHarnessToolSchema(tool.inputSchema)
        ctx.effect(() => ctx.tools.register({
          name: tool.name,
          description: tool.description,
          parameters,
          output: {
            schema: { type: 'string' },
            render: (_args, value) => {
              if (typeof value !== 'string') throw new Error('G1brain global tool result is not text')
              return [{ type: 'text', text: value }]
            },
          },
          execute: async (args, execution) => {
            if (!isRecord(args)) throw new Error('G1brain tool arguments must be an object')
            validateInput(tool.inputSchema, args)
            const result = await tool.execute(args, execution.signal)
            if (result.isError) throw new Error(result.content.map(block => block.text).join('\n'))
            const content = result.content.map(block => block.text).join('\n')
            const bytes = Buffer.from(content, 'utf8')
            return bytes.length <= GLOBAL_READ_RESULT_BYTES ? content
              : `${bytes.subarray(0, GLOBAL_READ_RESULT_BYTES).toString('utf8')}\n[G1brain 结果已截断，请缩小查询范围或分页]`
          },
        }), `g1brain: global read ${tool.name}`)
      }
    }
    ctx.on('agent/created', async ({ agent }) => { await this.attachAgent(agent) })
    for (const agent of ctx.agents.list()) {
      void this.attachAgent(agent).catch((error: unknown) => {
        ctx.logger.warn(`G1brain existing Session tools could not attach: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }

  /** Persist the selected targets for one newly created top-level Session.
   * @param request - Session identity and user-selected G1brain scope.
   * @returns confirmation after the private binding file is written and any live Agent receives its tools.
   */
  @Remote('bindSession')
  async bindSession(request: G1brainBindRequest): Promise<G1brainBindReceipt> {
    const session = this.ctx.sessions.get(request.sessionId)
    if (session === undefined) throw new Error('G1brain Session does not exist')
    await this.bindings.bind(session, request.target)
    const agent = this.ctx.agents.get(request.sessionId)
    if (agent !== undefined) await this.attachAgent(agent)
    return { sessionId: request.sessionId, bound: true }
  }

  private async attachAgent(agent: Agent): Promise<void> {
    if (this.installed.has(agent)) return
    let pending = this.attaching.get(agent)
    if (pending === undefined) {
      pending = this.installAgentTools(agent).finally(() => { this.attaching.delete(agent) })
      this.attaching.set(agent, pending)
    }
    await pending
  }

  private async installAgentTools(agent: Agent): Promise<void> {
    const session = this.ctx.sessions.get(agent.id)
    if (session === undefined || session.header.parentSession !== undefined || this.client === undefined) return
    const target = await this.bindings.load(session)
    if (target === undefined) return
    const scope = await openWorkspaceScope(target.folderPath)
    const task: PreparedTask = { ...target, instruction: '' }
    const prepared = createG1BrainTools({ client: this.client, scope, task })
      .filter(tool => !AGENT_MANAGEMENT_TOOLS.has(tool.name))
      .filter(tool => this.writesEnabled || !MUTATING_TOOLS.has(tool.name))
      .map((tool) => {
        const mutating = MUTATING_TOOLS.has(tool.name)
        const originalSchema = scopedSchema(tool.inputSchema, mutating, DELETION_TOOLS.has(tool.name))
        return { tool, mutating, originalSchema, parameters: toHarnessToolSchema(originalSchema) }
      })
    const disposers: Array<() => void> = []
    try {
      for (const entry of prepared) {
        const { tool, mutating, originalSchema, parameters } = entry
        disposers.push(agent.ctx.tools.register({
          name: tool.name,
          description: tool.description,
          parameters,
          output: {
            schema: { type: 'string' },
            render: (_args, value) => {
              if (typeof value !== 'string') throw new Error('G1brain tool result is not text')
              return [{ type: 'text', text: value }]
            },
          },
          execute: async (args, execution) => {
            if (execution.agent?.id !== agent.id) throw new Error('G1brain tool belongs to a different Session')
            const current = this.ctx.sessions.get(agent.id)
            const saved = current === undefined ? undefined : await this.bindings.load(current)
            if (saved === undefined || JSON.stringify(saved) !== JSON.stringify(target)) {
              throw new Error('G1brain Session binding is unavailable or changed')
            }
            if (!isRecord(args)) throw new Error('G1brain tool arguments must be an object')
            validateInput(originalSchema, args)
            assertTaskScope(task, tool.name, args)
            if (tool.name === 'g1brain_upload_selected_files') {
              const files = args.files
              if (!Array.isArray(files) || files.length === 0) throw new Error('G1brain upload requires explicit files')
              for (const file of files) {
                if (typeof file !== 'string') throw new Error('G1brain upload paths must be strings')
                await scope.inspect(file)
              }
            }
            if (mutating && !this.writesEnabled) throw new Error('G1brain write access is unavailable')
            if (requiresDeletionApproval(tool.name, args)) await this.approveDeletion(tool.name, args, execution)
            const result = await tool.execute(args, execution.signal)
            if (result.isError) throw new Error(result.content.map(block => block.text).join('\n'))
            return result.content.map(block => block.text).join('\n')
          },
        }))
      }
      this.installed.add(agent)
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose()
      throw error
    }
  }

  private async approveDeletion(name: string, args: Record<string, unknown>, execution: {
    readonly agent?: Agent
    readonly callId: ToolExecutionInput['callId']
    readonly signal: AbortSignal
  }): Promise<void> {
    const agent = execution.agent
    if (!this.writesEnabled || agent === undefined) throw new Error('G1brain write access is unavailable')
    if (args.confirm !== true) throw new Error('G1brain deletions and replacement imports require confirm=true')
    const preview = { ...args }
    if ('package' in preview) preview.package = '[ontology package payload]'
    const replacing = name === 'g1brain_import_ontology_package'
    const scope = '仅允许本次删除操作；不会授权后续删除。'
    const outcome = await this.ctx.approval.request({
      agent,
      toolName: name,
      callId: execution.callId,
      reason: `确认执行 G1brain 删除${replacing ? '（替换导入可能删除已有内容）' : ''}：${name} ${JSON.stringify(preview).slice(0, 2000)}。${scope}`,
      displayReason: {
        zh: `确认 G1brain 删除${replacing ? '（替换导入可能删除已有内容）' : ''}：${name} ${JSON.stringify(preview).slice(0, 1200)}。${scope}`,
        en: `Approve G1brain deletion${replacing ? ' (replacement import may remove existing content)' : ''}: ${name} ${JSON.stringify(preview).slice(0, 1200)}. Allow this deletion only; later deletions require separate approval.`,
      },
      signal: execution.signal,
    })
    if (outcome !== 'allowed-once') throw new Error(`G1brain deletion was not approved: ${outcome}`)
  }

  /** Report whether Host-side API credentials are configured without returning them.
   * @returns Whether catalog reads can be attempted.
   */
  @Remote
  status(): G1brainStatus {
    return { configured: this.endpoint !== undefined, mode: this.mode }
  }

  /** Read ontology collection names; fail explicitly without API credentials.
   * @param signal - optional caller cancellation.
   * @returns Available ontology collections.
   */
  @Remote
  async listOntologyCollections(signal?: AbortSignal): Promise<G1brainCatalogItem[]> {
    return itemsOf(await this.read('/kgApi/v1/gs/collections', signal))
  }

  /** Read domains within a selected ontology collection.
   * @param collectionName - existing collection name chosen by the user.
   * @param signal - optional caller cancellation.
   * @returns available domain names.
   */
  @Remote
  async listOntologyDomains(collectionName: string, signal?: AbortSignal): Promise<G1brainCatalogItem[]> {
    if (!collectionName.trim()) throw new Error('G1brain collectionName must not be blank')
    const collection = encodeURIComponent(collectionName.trim())
    return itemsOf(await this.read(`/kgApi/v1/gs/collections/${collection}/domains?view=detail`, signal))
  }

  /** Read document library names; fail explicitly without API credentials.
   * @param signal - optional caller cancellation.
   * @returns Available document libraries.
   */
  @Remote
  async listDocumentLibraries(signal?: AbortSignal): Promise<G1brainCatalogItem[]> {
    return itemsOf(await this.read('/mdApi/v1/md/collections', signal))
  }

  private async read(path: string, signal?: AbortSignal): Promise<unknown> {
    if (this.endpoint === undefined || this.authentication === undefined) throw new Error('G1brain API authentication is not configured')
    const response = await fetch(new URL(path.slice(1), this.endpoint), {
      headers: { ...this.authentication, 'Tenant-Id': this.config.tenantId, Accept: 'application/json' },
      redirect: 'error',
      signal: signal === undefined
        ? AbortSignal.timeout(this.config.timeoutMs)
        : AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]),
    })
    if (!response.ok) throw new Error(`G1brain catalog request failed (${response.status})`)
    const body: unknown = await response.json()
    if (body !== null && typeof body === 'object' && 'code' in body && typeof body.code === 'number' && body.code >= 400) {
      throw new Error(`G1brain catalog business request failed (${body.code})`)
    }
    return body
  }
}
