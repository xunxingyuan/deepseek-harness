import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import G1brainIntegration from '../src/index.ts'

const previous = Object.fromEntries(['DSH_HOME', 'G1BRAIN_AUTH_MODE', 'G1BRAIN_ALLOW_LOCAL_DEV',
  'G1BRAIN_ALLOW_DEV_WRITES', 'G1BRAIN_LOCAL_USER_ID', 'G1BRAIN_LOCAL_CLIENT_ID']
  .map(name => [name, process.env[name]]))
const roots: string[] = []
const contexts: Context[] = []

function parseJsonText(value: unknown): unknown {
  if (typeof value !== 'string') throw new Error('Expected a JSON string')
  return JSON.parse(value)
}

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function harness(allowWrites = true, tableBaseUrl = '') {
  const root = mkdtempSync(join(tmpdir(), 'g1brain-session-tools-'))
  roots.push(root)
  const materials = join(root, 'materials')
  mkdirSync(materials)
  process.env.DSH_HOME = root
  process.env.G1BRAIN_AUTH_MODE = 'local-dev'
  process.env.G1BRAIN_ALLOW_LOCAL_DEV = '1'
  process.env.G1BRAIN_ALLOW_DEV_WRITES = allowWrites ? '1' : '0'
  process.env.G1BRAIN_LOCAL_USER_ID = 'developer'
  process.env.G1BRAIN_LOCAL_CLIENT_ID = 'g1brain-web'
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const id = SessionId('session-g1brain-test')
  const session = { id, header: { cwd: materials } }
  const agent: { id: typeof id; ctx?: Context } = { id }
  const approval = vi.fn(async (_request: { callId?: string; displayReason?: { zh: string } }) => 'rejected')
  ctx.provide('sessions', { get: () => session } as never)
  ctx.provide('agents', { get: () => agent, list: () => [] } as never)
  ctx.provide('approval', { request: approval } as never)
  let scope!: ReturnType<typeof createScope>
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) },
    { inject: ['tools', 'sessions', 'agents', 'approval'] }))
  agent.ctx = scope.ctx
  const fetcher = vi.fn(async (url: string, init: RequestInit) => Response.json({ data:
    url.endsWith('/gs/collections') && init.method === 'POST' && typeof init.body === 'string'
      ? parseJsonText(init.body) : { name: '测试资料库' } }))
  vi.stubGlobal('fetch', fetcher)
  const fiber = await ctx.plugin(G1brainIntegration, { baseUrl: 'http://127.0.0.1:19091', clientId: 'test', tenantId: '000000', timeoutMs: 1000, tableBaseUrl })
  const service = ctx.get('g1brain') as G1brainIntegration
  return { ctx, scope, session, agent, service, approval, fetcher, materials, fiber }
}

describe('bound G1brain Session tools', () => {
  it.each([true, false])('keeps table-only Sessions scoped, with writes enabled: %s', async (allowWrites) => {
    const { ctx, agent, service, session, materials, approval, fetcher } = await harness(allowWrites, 'http://127.0.0.1:8090')
    await service.bindSession({ sessionId: session.id, target: { mode: 'new-ontology', folderPath: materials,
      createOntologyCollectionName: 'test_ontology', createDomainName: 'production' } })
    const names = ctx.tools.schemas(agent).map(tool => tool.name).filter(name => name.startsWith('g1brain_'))
    if (allowWrites) expect(names).toHaveLength(55)
    expect(names).toContain('g1brain_inspect_materials')
    expect(names).toContain('g1brain_query_data_tables')
    expect(names.includes('g1brain_fill_table_headers')).toBe(allowWrites)
    const execute = (name: string, args: object) => ctx.tools.execute({ signal: new AbortController().signal,
      callId: name as never, name, arguments: args, agent: agent as never })
    expect((await execute('g1brain_table_context', {})).isError).toBe(false)
    expect((await execute('g1brain_hybrid_search', { collectionName: 'foreign_library', query: 'secret' })).isError).toBe(true)
    expect(fetcher).not.toHaveBeenCalled()
    expect(approval).not.toHaveBeenCalled()
  })

  it('rejects a table-only binding when the table service is absent', async () => {
    const { service, session, materials } = await harness()
    await expect(service.bindSession({ sessionId: session.id, target: { mode: 'new-ontology', folderPath: materials,
      createOntologyCollectionName: 'test_ontology', createDomainName: 'production' } })).rejects.toThrow('表格服务')
  })

  it('refuses to resume a table-only Session after its table service is disabled', async () => {
    const { ctx, agent, service, session, materials, fiber } = await harness(true, 'http://127.0.0.1:8090')
    await service.bindSession({ sessionId: session.id, target: { mode: 'new-ontology', folderPath: materials,
      createOntologyCollectionName: 'test_ontology', createDomainName: 'production' } })
    await fiber.dispose()
    await ctx.plugin(G1brainIntegration, { baseUrl: 'http://127.0.0.1:19091', clientId: 'test', tenantId: '000000', timeoutMs: 1000 })
    await expect(ctx.serial('agent/created', { agent: { ...agent } as never, source: 'resume' })).rejects.toThrow('恢复表格服务配置')
  })

  it('lets an ordinary Session discover domains and search documents without exposing writes', async () => {
    const { ctx, agent, approval, fetcher } = await harness()
    fetcher.mockImplementation(async (url, init) => {
      if (url.includes('/domains')) return Response.json({ data: [{ name: '设备领域' }] })
      if (url.includes('/hybridSearch')) {
        expect(init.method).toBe('POST')
        return Response.json({ data: { text: 'x'.repeat(40_000) } })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const call = (name: string, argumentsValue: object) => ctx.tools.execute({ signal: new AbortController().signal,
      callId: name as never, name, arguments: argumentsValue, agent: agent as never })
    expect((await call('g1brain_list_ontology_domains', { collectionName: '' })).isError).toBe(true)
    expect(fetcher).not.toHaveBeenCalled()
    const domains = await call('g1brain_list_ontology_domains', { collectionName: 'test_ontology' })
    expect(domains.isError).toBe(false)
    expect(parseJsonText(domains.content.find(block => block.type === 'text')?.text)).toEqual([{ name: '设备领域' }])
    const search = await call('g1brain_hybrid_search', { collectionName: '测试资料库', query: 'equipment' })
    expect(search.isError).toBe(false)
    const output = search.content.find(block => block.type === 'text')?.text ?? ''
    expect(output).toContain('[G1brain 结果已截断，请缩小查询范围或分页]')
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThan(33_000)
    expect(approval).not.toHaveBeenCalled()
  })

  it('registers ontology and document tools only after a Session target is bound', async () => {
    const { ctx, agent, service, session, materials } = await harness()
    const before = ctx.tools.schemas(agent).map(tool => tool.name).filter(name => name.startsWith('g1brain_'))
    expect(before).toHaveLength(16)
    expect(before).toContain('g1brain_list_ontology_collections')
    expect(before).toContain('g1brain_list_ontology_domains')
    expect(before).toContain('g1brain_list_entity_taxonomy_nodes')
    expect(before).toContain('g1brain_list_ontology_properties')
    expect(before).toContain('g1brain_get_ontology_relations')
    expect(before).toContain('g1brain_hybrid_search')
    expect(before).not.toContain('g1brain_submit_document_task')
    await service.bindSession({ sessionId: session.id, target: {
      mode: 'new-ontology', folderPath: materials, createOntologyCollectionName: 'test_ontology',
      createDomainName: 'equipment', createDocumentLibraryName: '测试资料库',
    } })
    const after = ctx.tools.schemas(agent).map(tool => tool.name).filter(name => name.startsWith('g1brain_'))
    expect(after).toHaveLength(46)
    expect(after).toContain('g1brain_create_ontology_collection')
    expect(after).toContain('g1brain_upload_selected_files')
    expect(after).toContain('g1brain_submit_document_task')
    expect(after).toContain('g1brain_get_document_task')
    expect(after).not.toContain('g1brain_publish_agent')
    const other = {}
    const otherScope = createScope(ctx, other)
    expect(ctx.tools.schemas(other).map(tool => tool.name).filter(name => name.startsWith('g1brain_')))
      .toEqual(before)
    await otherScope.dispose()
  })

  it('creates bound resources without a confirmation flag or an approval request', async () => {
    const { ctx, agent, service, session, materials, approval, fetcher } = await harness()
    await service.bindSession({ sessionId: session.id, target: {
      mode: 'new-ontology', folderPath: materials, createOntologyCollectionName: 'test_ontology',
      createDomainName: 'equipment', createDocumentLibraryName: '测试资料库',
    } })
    const created = await ctx.tools.execute({ signal: new AbortController().signal,
      callId: 'automatic-create' as never, name: 'g1brain_create_ontology_collection',
      arguments: { name: 'test_ontology' }, agent: agent as never })
    expect(created.isError).toBe(false)
    expect(approval).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('keeps resource scoping enforced when non-deletion writes no longer need approval', async () => {
    const { ctx, agent, service, session, materials, approval, fetcher } = await harness()
    await service.bindSession({ sessionId: session.id, target: {
      mode: 'new-ontology', folderPath: materials, createOntologyCollectionName: 'test_ontology',
      createDomainName: 'equipment', createDocumentLibraryName: '测试资料库',
    } })
    const call = (argumentsValue: object) => ctx.tools.execute({ signal: new AbortController().signal,
      callId: 'write-test' as never, name: 'g1brain_create_document_library', arguments: argumentsValue, agent: agent as never })
    expect((await call({ name: '其他库', confirm: true })).isError).toBe(true)
    expect(approval).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
    const allowed = await call({ name: '测试资料库', confirm: false })
    expect(allowed.isError).toBe(false)
    expect(approval).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('refuses to resume a bound Session with an inaccessible materials folder instead of silently losing its tools', async () => {
    const { ctx, agent, service, session, materials } = await harness()
    await service.bindSession({ sessionId: session.id, target: {
      mode: 'new-ontology', folderPath: materials, createOntologyCollectionName: 'test_ontology',
      createDomainName: 'equipment', createDocumentLibraryName: '测试资料库',
    } })
    rmSync(materials, { recursive: true })
    await expect(ctx.serial('agent/created', { agent: { ...agent } as never, source: 'resume' })).rejects.toThrow()
  })

  it('creates repeated properties and updates them without approval or grant limits', async () => {
    const { ctx, agent, service, session, materials, approval, fetcher } = await harness()
    await service.bindSession({ sessionId: session.id, target: {
      mode: 'new-ontology', folderPath: materials, createOntologyCollectionName: 'test_ontology',
      createDomainName: 'equipment', createDocumentLibraryName: '测试资料库',
    } })
    const property = (sid: string) => ctx.tools.execute({ signal: new AbortController().signal,
      callId: `property-${sid}` as never, name: 'g1brain_create_ontology_property',
      arguments: { collectionName: 'test_ontology', domainName: 'equipment', sid, displayName: sid,
        valueType: 'STRING', kind: 'SCALAR' }, agent: agent as never })
    for (let index = 0; index < 105; index += 1) expect((await property(`property-${index}`)).isError).toBe(false)
    const updated = await ctx.tools.execute({ signal: new AbortController().signal,
      callId: 'update-property' as never, name: 'g1brain_update_ontology_property',
      arguments: { collectionName: 'test_ontology', domainName: 'equipment', propertySid: 'property-1', properties: { description: '更新说明' } },
      agent: agent as never })
    expect(updated.isError).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(106)
    expect(approval).not.toHaveBeenCalled()
  })

  it.each([
    ['g1brain_delete_ontology_entity', { nodeId: '1', expectedSid: 'entity-1' }],
    ['g1brain_delete_ontology_relation', { relationId: 'relation-1' }],
    ['g1brain_delete_ontology_property', { nodeId: 'property-1' }],
    ['g1brain_delete_ontology_relation_type', { relationSid: 'relation-type-1' }],
  ] as const)('blocks %s without explicit intent or when approval is rejected', async (name, target) => {
    const { ctx, agent, service, session, materials, approval, fetcher } = await harness()
    await service.bindSession({ sessionId: session.id, target: {
      mode: 'new-ontology', folderPath: materials, createOntologyCollectionName: 'test_ontology',
      createDomainName: 'equipment', createDocumentLibraryName: '测试资料库',
    } })
    const call = (args: object) => ctx.tools.execute({ signal: new AbortController().signal,
      callId: 'delete-test' as never, name, arguments: args, agent: agent as never })
    const args = { collectionName: 'test_ontology', domainName: 'equipment', ...target }
    expect((await call(args)).isError).toBe(true)
    expect(approval).not.toHaveBeenCalled()
    expect((await call({ ...args, confirm: false })).isError).toBe(true)
    expect(approval).not.toHaveBeenCalled()
    expect((await call({ ...args, confirm: true })).isError).toBe(true)
    expect(approval).toHaveBeenCalledTimes(1)
    expect(approval.mock.calls[0]?.[0].displayReason?.zh).toContain('确认 G1brain 删除')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('approves replacement imports as deletions but allows additive imports directly', async () => {
    const { ctx, agent, service, session, materials, approval, fetcher } = await harness()
    await service.bindSession({ sessionId: session.id, target: {
      mode: 'new-ontology', folderPath: materials, createOntologyCollectionName: 'test_ontology',
      createDomainName: 'equipment', createDocumentLibraryName: '测试资料库',
    } })
    const pkg = { targets: { collection: { defaultName: 'test_ontology' }, domains: [{ name: 'equipment' }] } }
    const call = (options: object) => ctx.tools.execute({ signal: new AbortController().signal,
      callId: 'package-import' as never, name: 'g1brain_import_ontology_package',
      arguments: { collectionName: 'test_ontology', package: pkg, ...options }, agent: agent as never })
    expect((await call({ replace: false })).isError).toBe(false)
    expect(approval).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect((await call({ replace: true })).isError).toBe(true)
    expect(approval).not.toHaveBeenCalled()
    expect((await call({ replace: true, confirm: true })).isError).toBe(true)
    expect(approval).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(approval.mock.calls[0]?.[0].displayReason?.zh).toContain('替换导入可能删除已有内容')
    approval.mockResolvedValueOnce('allowed-once')
    expect((await call({ replace: true, confirm: true })).isError).toBe(false)
    expect(approval).toHaveBeenCalledTimes(2)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1]?.[0]).toContain('replace=true')
  })

  it('does not grant write access when development writes are disabled', async () => {
    const { ctx, agent, service, session, materials, approval, fetcher } = await harness(false)
    await service.bindSession({ sessionId: session.id, target: {
      mode: 'new-ontology', folderPath: materials, createOntologyCollectionName: 'test_ontology',
      createDomainName: 'equipment', createDocumentLibraryName: '测试资料库',
    } })
    const names = ctx.tools.schemas(agent).map(tool => tool.name)
    expect(names).not.toContain('g1brain_create_ontology_collection')
    expect(names).not.toContain('g1brain_delete_ontology_property')
    expect(names).toContain('g1brain_read_selected_file')
    const result = await ctx.tools.execute({ signal: new AbortController().signal,
      callId: 'disabled-create' as never, name: 'g1brain_create_ontology_collection',
      arguments: { name: 'test_ontology' }, agent: agent as never })
    expect(result.isError).toBe(true)
    expect(approval).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('never shares or reuses approval between parallel deletions', async () => {
    const { ctx, agent, service, session, materials, approval, fetcher } = await harness()
    await service.bindSession({ sessionId: session.id, target: {
      mode: 'new-ontology', folderPath: materials, createOntologyCollectionName: 'test_ontology',
      createDomainName: 'equipment', createDocumentLibraryName: '测试资料库',
    } })
    const first = Promise.withResolvers<string>(), second = Promise.withResolvers<string>()
    approval.mockImplementation(async request => request.callId === 'delete-first' ? first.promise
      : request.callId === 'delete-second' ? second.promise : 'rejected')
    const call = (nodeId: string) => ctx.tools.execute({ signal: new AbortController().signal,
      callId: `delete-${nodeId}` as never, name: 'g1brain_delete_ontology_property',
      arguments: { collectionName: 'test_ontology', domainName: 'equipment', nodeId, confirm: true }, agent: agent as never })
    const calls = [call('first'), call('second')]
    const settled = Promise.allSettled(calls)
    try {
      await vi.waitFor(() => { expect(approval).toHaveBeenCalledTimes(2) })
      expect(fetcher).not.toHaveBeenCalled()
      first.resolve('allowed-once')
      second.resolve('rejected')
      const results = await Promise.all(calls)
      expect(results.map(result => result.isError)).toEqual([false, true])
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(fetcher.mock.calls[0]?.[1].method).toBe('DELETE')
      expect((await call('third')).isError).toBe(true)
      expect(approval).toHaveBeenCalledTimes(3)
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      first.resolve('rejected')
      second.resolve('rejected')
      await settled
    }
  })

  it('uploads selected relative files without approval and still rejects paths outside the materials directory', async () => {
    const { ctx, agent, service, session, materials, approval, fetcher } = await harness()
    writeFileSync(join(materials, 'evidence.md'), '# test evidence')
    await service.bindSession({ sessionId: session.id, target: {
      mode: 'new-ontology', folderPath: materials, createOntologyCollectionName: 'test_ontology',
      createDomainName: 'equipment', createDocumentLibraryName: '测试资料库',
    } })
    const invoke = (files: string[]) => ctx.tools.execute({ signal: new AbortController().signal,
      callId: 'upload-test' as never, name: 'g1brain_upload_selected_files',
      arguments: { collectionName: '测试资料库', files }, agent: agent as never })
    expect((await invoke(['../outside.md'])).isError).toBe(true)
    expect(approval).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
    const uploaded = await invoke(['evidence.md'])
    expect(uploaded.isError).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[0]).toContain('/mdApi/v1/md/collections/')
    expect(fetcher.mock.calls[0]?.[1].body).toBeInstanceOf(FormData)
    expect(approval).not.toHaveBeenCalled()
  })

  it('submits MD and CHUNK processing tasks only for files in the bound library without approval', async () => {
    const { ctx, agent, service, session, materials, approval, fetcher } = await harness()
    await service.bindSession({ sessionId: session.id, target: {
      mode: 'new-ontology', folderPath: materials, createOntologyCollectionName: 'test_ontology',
      createDomainName: 'equipment', createDocumentLibraryName: '测试资料库',
    } })
    fetcher.mockImplementation(async (url) => {
      if (url.endsWith('/all')) return Response.json({ data: [{ id: 11 }, { id: 12 }] })
      if (url.endsWith('/tasks/submit')) return Response.json({ data: { taskId: 'task-created' } })
      throw new Error(`Unexpected request: ${url}`)
    })
    const submit = (argumentsValue: object) => ctx.tools.execute({ signal: new AbortController().signal,
      callId: 'task-submit' as never, name: 'g1brain_submit_document_task', arguments: argumentsValue, agent: agent as never })
    expect((await submit({ collectionName: 'test_ontology', type: 'MD', fileSelection: 'all' })).isError).toBe(true)
    expect(fetcher).not.toHaveBeenCalled()
    expect((await submit({ collectionName: '其他库', type: 'MD', fileSelection: 'all', confirm: true })).isError).toBe(true)
    expect(approval).not.toHaveBeenCalled()
    expect((await submit({ collectionName: '测试资料库', type: 'MD', fileSelection: 'all', operations: ['indexCreate'] })).isError).toBe(true)
    expect(approval).not.toHaveBeenCalled()
    expect((await submit({ collectionName: '测试资料库', type: 'MD', fileSelection: 'all' })).isError).toBe(false)
    const firstBody = fetcher.mock.calls.find(([url]) => url.endsWith('/tasks/submit'))?.[1].body
    expect(parseJsonText(firstBody)).toEqual({ type: 'MD', operations: ['slice'], mdIds: [11, 12],
      mdType: 'simple', chunkMetadata: {}, chunkSize: 512 })
    expect((await submit({ collectionName: '测试资料库', type: 'CHUNK', fileSelection: 'selected', mdIds: [12],
      operations: ['keywords', 'vectorization', 'indexCreate'] })).isError).toBe(false)
    expect((await submit({ collectionName: '测试资料库', type: 'CHUNK', fileSelection: 'selected', mdIds: [99],
      operations: ['indexCreate'], confirm: true })).isError).toBe(true)
    const submissions = fetcher.mock.calls.filter(([url]) => url.endsWith('/tasks/submit'))
    expect(submissions).toHaveLength(2)
    expect(submissions.map(([url]) => decodeURIComponent(new URL(url).pathname)))
      .toEqual(['/mdApi/v1/md/collections/测试资料库/tasks/submit', '/mdApi/v1/md/collections/测试资料库/tasks/submit'])
    expect(parseJsonText(submissions[1]?.[1].body)).toEqual({ type: 'CHUNK', mdIds: [12],
      operations: ['keywords', 'vectorization', 'indexCreate'],
      embeddingMetadata: { keywords: 'keywords', llm_questions: 'faqs', _currentSectionToc: 'ToC', _heading: 'heading' },
      chunkMetadata: { _fileName: '文件名称', _currentSectionToc: '文档层级结构', _heading: '该段标题' },
      extraContent: [] })
    expect(approval).not.toHaveBeenCalled()
  })

  it('reads compact task status, waits for a terminal task, and cancels without deletion approval', async () => {
    const { ctx, agent, service, session, materials, approval, fetcher } = await harness()
    await service.bindSession({ sessionId: session.id, target: {
      mode: 'new-ontology', folderPath: materials, createOntologyCollectionName: 'test_ontology',
      createDomainName: 'equipment', createDocumentLibraryName: '测试资料库',
    } })
    const task = { taskId: 'task-1', type: 'MD', status: 'SUCCESS', terminal: true, objectIds: [11],
      objectStatus: { 11: { states: [{ operation: 'slice', status: 'SUCCESS' }] } } }
    fetcher.mockImplementation(async (url) => {
      if (url.endsWith('/tasks')) return Response.json({ data: [task] })
      if (url.endsWith('/tasks/task-1/status')) return Response.json({ data: task.objectStatus })
      if (url.endsWith('/tasks/task-1')) return Response.json({ data: task })
      if (url.endsWith('/tasks/task-1/cancel')) return Response.json({ data: { cancelled: true } })
      throw new Error(`Unexpected request: ${url}`)
    })
    const execute = (name: string, argumentsValue: object) => ctx.tools.execute({ signal: new AbortController().signal,
      callId: name as never, name, arguments: argumentsValue, agent: agent as never })
    const list = await execute('g1brain_list_document_tasks', { collectionName: '测试资料库' })
    expect(list.isError).toBe(false)
    expect(parseJsonText(list.content.find(block => block.type === 'text')?.text)).toEqual({ total: 1,
      tasks: [{ fileCount: 1, taskId: 'task-1', type: 'MD', status: 'SUCCESS', terminal: true }] })
    const statuses = await execute('g1brain_get_document_task_file_statuses', { collectionName: '测试资料库', taskId: 'task-1' })
    expect(statuses.isError).toBe(false)
    expect(parseJsonText(statuses.content.find(block => block.type === 'text')?.text)).toMatchObject({ files: [{ fileId: '11' }] })
    const waited = await execute('g1brain_wait_document_task', { collectionName: '测试资料库', taskId: 'task-1' })
    expect(waited.isError).toBe(false)
    expect(parseJsonText(waited.content.find(block => block.type === 'text')?.text)).toMatchObject({ completed: true })
    expect(approval).not.toHaveBeenCalled()
    const cancelled = await execute('g1brain_cancel_document_task', { collectionName: '测试资料库', taskId: 'task-1' })
    expect(cancelled.isError).toBe(false)
    expect(fetcher.mock.calls.find(([url]) => url.endsWith('/cancel'))?.[1].method).toBe('POST')
    expect(approval).not.toHaveBeenCalled()
  })
})
