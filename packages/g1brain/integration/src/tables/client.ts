/** Bounded REST uploads and collection-bound read-only MCP queries for the table service. */
import { Buffer } from 'node:buffer'

/** A collection returned by the table service, not a G1brain ontology collection. */
export interface TableCollection {
  readonly id: string
  readonly name: string
  readonly description: string
}

/** Validated import job fields exposed to the agent. */
export interface TableJob {
  readonly id: string
  readonly filename: string
  readonly status: 'queued' | 'analyzing' | 'importing' | 'completed' | 'partial' | 'failed' | 'needs_input'
  readonly detail: string
  readonly datasets: readonly string[]
  readonly collection_ids: readonly string[]
  readonly sheets: readonly unknown[]
}

/** HTTP failure whose status distinguishes a rejected request from an uncertain write. */
export class TableApiError extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}

/** Narrow untrusted JSON values returned by the table service.
 * @param value - wire or saved JSON value.
 * @returns whether the value is a non-array object.
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(value)) throw new Error('表格服务返回了无效的资源 ID')
  return value
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('表格服务返回的 ID 列表无效')
  return value.map(identifier)
}

/** Table service settings owned by the Host. */
export interface TableClientOptions {
  readonly baseUrl: string
  readonly timeoutMs: number
  readonly maxUploadBytes: number
}

/** HTTP client with no arbitrary MCP write or URL execution method. */
export class TableClient {
  /** Normalized service identity used to separate durable domain mappings. */
  readonly baseUrl: string
  private readonly endpoint: URL
  private sequence = 0
  private initialization: Promise<string> | undefined

  constructor(readonly options: TableClientOptions, private readonly fetcher: typeof fetch = fetch) {
    const endpoint = new URL(options.baseUrl)
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error('tableBaseUrl 必须是无凭据、查询参数和片段的 HTTP(S) 地址')
    }
    this.endpoint = new URL(endpoint.href.endsWith('/') ? endpoint.href : endpoint.href + '/')
    this.baseUrl = this.endpoint.href
  }

  private async request(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
    const headers = new Headers(init.headers)
    if (!headers.has('Accept')) headers.set('Accept', 'application/json')
    const response = await this.fetcher(new URL(path, this.endpoint), {
      ...init, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)])
        : AbortSignal.timeout(this.options.timeoutMs),
      headers,
    })
    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    if (reader) {
      try {
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          size += next.value.byteLength
          if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('表格服务响应过大，请缩小查询范围') }
          chunks.push(next.value)
        }
      } finally { reader.releaseLock() }
    }
    const text = Buffer.concat(chunks).toString('utf8')
    let value: unknown
    try { value = text ? JSON.parse(text) : null }
    catch (error) { throw new Error('表格服务没有返回可识别的 JSON', { cause: error }) }
    if (!response.ok) throw new TableApiError(`表格服务请求失败（${response.status}）：${isObject(value) ? JSON.stringify(value.detail ?? '').slice(0, 400) : ''}`, response.status)
    return value
  }

  /** List collection identities for Host-side mapping only.
   * @param signal - caller cancellation.
   * @returns bounded, validated collection metadata.
   */
  async collections(signal?: AbortSignal): Promise<TableCollection[]> {
    const value = await this.request('api/collections', {}, signal)
    if (!Array.isArray(value)) throw new Error('表格集合目录无效')
    return value.map((item) => {
      if (!isObject(item) || typeof item.name !== 'string' || typeof item.description !== 'string') throw new Error('表格集合记录无效')
      return { id: identifier(item.id), name: item.name, description: item.description }
    })
  }

  /** Create an empty collection without modifying an existing collection's members.
   * @param name - business display name, at most 80 Unicode characters.
   * @param description - stable source marker used to reject foreign same-name collections.
   * @param signal - caller cancellation.
   * @returns created collection identity.
   */
  async createCollection(name: string, description: string, signal?: AbortSignal): Promise<TableCollection> {
    const value = await this.request('api/collections', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, dataset_ids: [] }) }, signal)
    if (!isObject(value) || value.name !== name || value.description !== description) throw new Error('表格集合创建结果与请求不一致')
    return { id: identifier(value.id), name, description }
  }

  /** Upload one preflighted data-only workbook; never retry this write automatically.
   * @param collectionId - mapped collection ID, never a domain or display name.
   * @param filename - generated workbook name retaining its source association.
   * @param bytes - complete generated XLSX bytes.
   * @param signal - caller cancellation.
   * @returns accepted import-job IDs, not completed table IDs.
   */
  async upload(collectionId: string, filename: string, bytes: Buffer, signal?: AbortSignal): Promise<string[]> {
    if (bytes.length > this.options.maxUploadBytes) throw new Error('表格文件超过 tableMaxUploadBytes，请拆分后导入')
    const form = new FormData()
    form.append('files', new File([new Uint8Array(bytes)], filename, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
    form.append('collection_ids', identifier(collectionId))
    const value = await this.request('api/uploads', { method: 'POST', body: form }, signal)
    if (!isObject(value)) throw new Error('表格上传响应无效；上传结果可能已生效，请先核对任务')
    const ids = strings(value.job_ids)
    if (!ids.length || ids.length > 20) throw new Error('表格上传没有返回有效任务 ID；请核对服务端任务')
    return ids
  }

  /** Read recent jobs, narrowing returned data to IDs persisted by this Host.
   * @param ids - job IDs from owned upload receipts.
   * @param collectionId - the current domain's mapped collection.
   * @param signal - caller cancellation.
   * @returns matched jobs; absent IDs are unknown, never implicitly successful.
   */
  async jobs(ids: readonly string[], collectionId: string, signal?: AbortSignal): Promise<TableJob[]> {
    const value = await this.request('api/jobs', {}, signal)
    if (!Array.isArray(value)) throw new Error('表格任务列表无效')
    return value.flatMap((item) => {
      if (!isObject(item) || !ids.includes(String(item.id))) return []
      const members = strings(item.collection_ids)
      if (!members.includes(collectionId)) throw new Error('表格任务不属于当前领域绑定集合')
      if (!['queued', 'analyzing', 'importing', 'completed', 'partial', 'failed', 'needs_input'].includes(String(item.status))
        || typeof item.filename !== 'string' || typeof item.detail !== 'string' || !Array.isArray(item.sheets)) throw new Error('表格任务状态无效')
      return [{ id: identifier(item.id), filename: item.filename, detail: item.detail, datasets: strings(item.datasets),
        collection_ids: members, sheets: item.sheets, status: item.status as TableJob['status'] }]
    })
  }

  private async protocol(signal?: AbortSignal): Promise<string> {
    this.initialization ??= (async () => {
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26' }
      const id = ++this.sequence
      const value = await this.request('mcp/', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id,
        method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'g1brain-tables', version: '1.0.0' } } }) }, signal)
      if (!isObject(value) || value.id !== id || value.error || !isObject(value.result) || typeof value.result.protocolVersion !== 'string') throw new Error('表格 MCP 初始化失败')
      const protocol = value.result.protocolVersion
      await this.request('mcp/', { method: 'POST', headers: { ...headers, 'MCP-Protocol-Version': protocol },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }, signal)
      return protocol
    })().catch((error: unknown) => { this.initialization = undefined; throw error })
    return this.initialization
  }

  /** Read a header-repair preview after the caller has checked ownership of the job.
   * @param jobId - persisted owned upload job.
   * @param sheet - original worksheet name.
   * @param headerRow - optional 1-based header row.
   * @param signal - caller cancellation.
   * @returns missing-header evidence from the service.
   */
  async headerPreview(jobId: string, sheet: string, headerRow?: number, signal?: AbortSignal): Promise<unknown> {
    const query = new URLSearchParams({ sheet, ...(headerRow === undefined ? {} : { header_row: String(headerRow) }) })
    return this.request(`api/jobs/${identifier(jobId)}/header-preview?${query}`, {}, signal)
  }

  /** Fill missing headers without exposing the service's column-discard operation.
   * @param jobId - persisted owned upload job.
   * @param sheet - worksheet selected from the job preview.
   * @param headerRow - 1-based header row.
   * @param headers - explicit missing-column indices and names.
   * @param signal - caller cancellation.
   * @returns the service's accepted resume response, not completed import state.
   */
  async fillHeaders(jobId: string, sheet: string, headerRow: number, headers: Record<string, string>,
    signal?: AbortSignal): Promise<unknown> {
    return this.request(`api/jobs/${identifier(jobId)}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheet, header_row: headerRow, mode: 'fill', headers }) }, signal)
  }

  /** Read only named MCP capabilities through a collection-bound URL.
   * @param collectionId - mapped current-domain collection.
   * @param name - one fixed read-only tool name.
   * @param args - tool-specific arguments; scope is always supplied by the Host.
   * @param signal - caller cancellation.
   * @returns structured result, after JSON-RPC and MCP error checks.
   */
  async read(collectionId: string, name: 'list_tables' | 'describe_table' | 'preview_table' | 'query_tables', args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const protocol = await this.protocol(signal)
    const id = ++this.sequence
    const path = `mcp/?collection_id=${encodeURIComponent(identifier(collectionId))}`
    const value = await this.request(path, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': protocol },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { ...args, collection_ids: [collectionId] } } }) }, signal)
    if (!isObject(value) || value.id !== id || value.error || !isObject(value.result) || value.result.isError === true) {
      throw new Error(`表格 MCP 查询失败：${JSON.stringify(value).slice(0, 500)}`)
    }
    if (!('structuredContent' in value.result)) throw new Error('表格 MCP 缺少结构化查询结果')
    return value.result.structuredContent
  }
}
