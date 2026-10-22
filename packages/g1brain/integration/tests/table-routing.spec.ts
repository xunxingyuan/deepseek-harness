import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'
import { openWorkspaceScope } from '../src/legacy/bridge/scope.ts'
import { createG1BrainClient } from '../src/legacy/g1brain/client.ts'
import { isObject, TableClient, type TableCollection } from '../src/tables/client.ts'
import { MaterialRouter } from '../src/tables/router.ts'
import { digest, TableStore } from '../src/tables/store.ts'
import { tableWorkbook, workbookCell } from './fixtures/table-workbooks.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture(library = true, notes = true) {
  const root = await mkdtemp(join(tmpdir(), 'g1brain-table-routing-'))
  roots.push(root)
  const source = tableWorkbook(notes)
  await writeFile(join(root, '中文数据.xlsx'), source)
  const collections: TableCollection[] = []
  const uploads: File[] = []
  const markdown: string[] = []
  const calls: Array<{ url: URL; body: Record<string, unknown> }> = []
  const state = { uploadFailure: 0, loseUploadResponse: false, jobStatus: 'completed', omitJob: false, mcpError: false }
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input)
    const headers = new Headers(init.headers)
    if (url.hostname === 'tables.test') {
      expect(headers.get('X-User-Id')).toBeNull()
      expect(headers.get('Blade-Auth')).toBeNull()
      expect(headers.get('Authorization')).toBeNull()
      if (url.pathname === '/api/collections') {
        if (init.method !== 'POST') return Response.json(collections)
        if (typeof init.body !== 'string') throw new Error('Expected JSON body')
        const value: unknown = JSON.parse(init.body)
        if (!isObject(value) || typeof value.name !== 'string' || typeof value.description !== 'string') throw new Error('Invalid collection')
        expect(value.dataset_ids).toEqual([])
        const collection = { id: 'test-collection', name: value.name, description: value.description }
        collections.push(collection)
        return Response.json(collection, { status: 201 })
      }
      if (url.pathname === '/api/uploads') {
        if (state.uploadFailure) return Response.json({ detail: 'rejected' }, { status: state.uploadFailure })
        if (!(init.body instanceof FormData)) throw new Error('Expected multipart upload')
        expect(init.body.getAll('collection_ids')).toEqual(['test-collection'])
        const file = init.body.get('files')
        if (!(file instanceof File)) throw new Error('Missing workbook')
        uploads.push(file)
        if (state.loseUploadResponse) throw new Error('Connection lost after accepting the upload')
        return Response.json({ job_ids: ['job-test'] }, { status: 202 })
      }
      if (url.pathname === '/api/jobs') return Response.json(state.omitJob ? [] : [{ id: 'job-test', filename: 'table.xlsx',
        status: state.jobStatus, detail: '', datasets: ['dataset-test'], collection_ids: ['test-collection'], sheets: [] }])
      if (url.pathname.endsWith('/header-preview')) return Response.json({ missing_columns: [2] })
      if (url.pathname.endsWith('/resume')) {
        if (typeof init.body !== 'string') throw new Error('Expected JSON body')
        expect(JSON.parse(init.body)).toMatchObject({ mode: 'fill', headers: { '2': '数量' } })
        return Response.json({ status: 'queued' })
      }
      if (url.pathname === '/mcp/') {
        if (typeof init.body !== 'string') throw new Error('Expected JSON body')
        const body: unknown = JSON.parse(init.body)
        if (!isObject(body)) throw new Error('Invalid RPC')
        calls.push({ url, body })
        if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } })
        if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
        expect(url.searchParams.get('collection_id')).toBe('test-collection')
        expect(body.params).toMatchObject({ arguments: { collection_ids: ['test-collection'] } })
        return Response.json({ jsonrpc: '2.0', id: body.id, result: state.mcpError ? { isError: true, content: [] }
          : { structuredContent: { rows: [{ total: '215', big: '9007199254740993' }] } } })
      }
    } else if (url.pathname.endsWith('/mds')) {
      if (!(init.body instanceof FormData)) throw new Error('Missing document form')
      const file = init.body.get('file')
      if (!(file instanceof File)) throw new Error('Missing Markdown')
      markdown.push(await file.text())
      return Response.json({ data: { name: file.name } })
    }
    throw new Error(`Unexpected request: ${url}`)
  })
  const tables = new TableClient({ baseUrl: 'http://tables.test', timeoutMs: 1000, maxUploadBytes: 25 * 1024 * 1024 }, fetcher)
  const documents = createG1BrainClient({ baseUrl: 'http://documents.test', authMode: 'local-dev', clientId: 'test', clientSecret: '',
    publicKey: '', timeoutMs: 1000, tenantId: '000000', localUserId: 'developer', localClientId: 'test' }, fetcher)
  const store = new TableStore(join(root, 'journal'), 'ontology:test;domain:production')
  const router = new MaterialRouter({ scope: await openWorkspaceScope(root), tables, documents, store,
    target: { mode: 'update-ontology', folderPath: root, ontologyCollectionName: 'test', domainName: 'production',
      ...(library ? { documentLibraryName: 'notes' } : {}) }, domainDisplayName: async () => '生产领域' })
  return { root, source, collections, uploads, markdown, calls, state, fetcher, tables, store, router }
}

describe('domain-bound material imports', () => {
  it('preflights mixed Excel without writes, then uploads data and explanatory sheets separately', async () => {
    const f = await fixture()
    expect(await f.router.inspect(['中文数据.xlsx'])).toMatchObject({ uploads: [{ kind: 'table' }, { kind: 'document' }] })
    expect(f.fetcher).not.toHaveBeenCalled()
    expect(await f.router.upload(['中文数据.xlsx'])).toMatchObject({ status: 'accepted', tableUploads: 1, documentUploads: 1 })
    expect(f.collections[0]?.name).toBe('生产领域')
    const file = f.uploads[0]
    if (!file) throw new Error('No upload')
    const workbook = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: 'buffer' })
    expect(workbook.SheetNames).toEqual(['生产数据'])
    expect(workbookCell(workbook, '生产数据', 'A3')?.v).toBe('002')
    expect(f.markdown).toHaveLength(1)
    expect(f.markdown[0]).toContain('这是说明正文')
    expect(f.markdown[0]).not.toContain('9007199254740993')
    expect(await readFile(join(f.root, '中文数据.xlsx'))).toEqual(f.source)
    expect(await f.router.imports()).toMatchObject({ jobs: [{ status: 'completed' }], missingJobIds: [] })
    expect(await f.router.read('query_tables', { sql: 'SELECT SUM(产量) AS total FROM data_test', collection_ids: ['foreign'] }))
      .toEqual({ rows: [{ total: '215', big: '9007199254740993' }] })
  })

  it('supports pure tables without a vector library but rejects mixed content before any remote write', async () => {
    const mixed = await fixture(false)
    await expect(mixed.router.upload(['中文数据.xlsx'])).rejects.toThrow('未选择向量文档库')
    expect(mixed.fetcher).not.toHaveBeenCalled()
    const pure = await fixture(false, false)
    expect(await pure.router.upload(['中文数据.xlsx'])).toMatchObject({ tableUploads: 1, documentUploads: 0 })
    expect(pure.markdown).toEqual([])
  })

  it('reuses accepted receipts across restarts and never includes file bytes in the journal', async () => {
    const f = await fixture()
    await f.router.upload(['中文数据.xlsx'])
    expect(await f.router.upload(['中文数据.xlsx'])).toMatchObject({ results: [{ reused: true }, { reused: true }] })
    expect(f.uploads).toHaveLength(1)
    expect(f.markdown).toHaveLength(1)
    const loaded = new TableStore(join(f.root, 'journal'), f.store.source)
    expect(await loaded.collection()).toEqual(f.collections[0])
    const receipts = await loaded.receipts()
    expect(receipts).toHaveLength(2)
    expect(receipts.every(item => !('bytes' in item))).toBe(true)
    await expect(loaded.bind({ id: 'foreign', name: 'other', description: '' })).rejects.toThrow('不能覆盖绑定')
    const other = new TableStore(join(f.root, 'journal'), 'ontology:other;domain:production')
    expect(await other.collection()).toBeUndefined()
    expect(await other.receipts()).toEqual([])
  })

  it('does not adopt foreign same-name collections or widen reads before the first import', async () => {
    const f = await fixture(false, false)
    f.collections.push({ id: 'foreign', name: '生产领域', description: 'business-owned' })
    expect(await f.router.read('list_tables', {})).toMatchObject({ tables: [] })
    expect(f.fetcher).not.toHaveBeenCalled()
    await f.router.upload(['中文数据.xlsx'])
    expect(f.collections[1]?.name).toBe(`生产领域 [${f.store.scopeKey.slice(0, 8)}]`)
    expect(f.collections[0]).toEqual({ id: 'foreign', name: '生产领域', description: 'business-owned' })
    f.state.mcpError = true
    await expect(f.router.read('describe_table', { dataset_id: 'foreign-table' })).rejects.toThrow('MCP 查询失败')
  })

  it('blocks duplicate uploads after a lost acknowledgment without falling back to vector storage', async () => {
    const f = await fixture()
    f.state.loseUploadResponse = true
    await expect(f.router.upload(['中文数据.xlsx'])).rejects.toThrow('Connection lost')
    f.state.loseUploadResponse = false
    await expect(f.router.upload(['中文数据.xlsx'])).rejects.toThrow('结果不确定')
    expect(f.uploads).toHaveLength(1)
    expect(f.markdown).toEqual([])
  })

  it('permits retry after a definite rejection, and permits only one concurrent uploader', async () => {
    const f = await fixture(false, false)
    f.state.uploadFailure = 413
    await expect(f.router.upload(['中文数据.xlsx'])).rejects.toThrow('413')
    f.state.uploadFailure = 0
    const results = await Promise.allSettled([f.router.upload(['中文数据.xlsx']), f.router.upload(['中文数据.xlsx'])])
    expect(results.some(result => result.status === 'fulfilled')).toBe(true)
    expect(f.uploads).toHaveLength(1)
  })

  it('reports partial and missing jobs honestly and fills headers only for owned blocked jobs', async () => {
    const f = await fixture(false, false)
    await f.router.upload(['中文数据.xlsx'])
    f.state.jobStatus = 'partial'
    expect(await f.router.imports()).toMatchObject({ jobs: [{ status: 'partial' }] })
    expect(await f.router.headerPreview('job-test', '生产数据')).toEqual({ missing_columns: [2] })
    expect(await f.router.fillHeaders('job-test', '生产数据', 1, { '2': '数量' })).toEqual({ status: 'queued' })
    await expect(f.router.fillHeaders('foreign-job', '生产数据', 1, { '2': '数量' })).rejects.toThrow('不属于')
    f.state.jobStatus = 'completed'
    await expect(f.router.fillHeaders('job-test', '生产数据', 1, { '2': '数量' })).rejects.toThrow()
    f.state.omitJob = true
    expect(await f.router.imports()).toMatchObject({ jobs: [], missingJobIds: ['job-test'] })
  })

  it('fails closed on a corrupt receipt instead of repeating a possible write', async () => {
    const f = await fixture(false, false)
    await f.router.upload(['中文数据.xlsx'])
    const receipt = (await f.store.receipts())[0]
    if (!receipt) throw new Error('No receipt')
    await writeFile(join(f.root, 'journal', f.store.scopeKey, `${receipt.key}.receipt.json`), '{}')
    await expect(f.router.upload(['中文数据.xlsx'])).rejects.toThrow('记录的版本或绑定范围不匹配')
    expect(f.uploads).toHaveLength(1)
    expect(await f.store.reserve(digest('new source'))).toBe(true)
    expect(await f.store.reserve(digest('new source'))).toBe(false)
  })
})
