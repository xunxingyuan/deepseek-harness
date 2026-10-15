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

async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'g1brain-session-tools-'))
  roots.push(root)
  const materials = join(root, 'materials')
  mkdirSync(materials)
  process.env.DSH_HOME = root
  process.env.G1BRAIN_AUTH_MODE = 'local-dev'
  process.env.G1BRAIN_ALLOW_LOCAL_DEV = '1'
  process.env.G1BRAIN_ALLOW_DEV_WRITES = '1'
  process.env.G1BRAIN_LOCAL_USER_ID = 'developer'
  process.env.G1BRAIN_LOCAL_CLIENT_ID = 'g1brain-web'
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const id = SessionId('session-g1brain-test')
  const session = { id, header: { cwd: materials } }
  const agent: { id: typeof id; ctx?: Context } = { id }
  const approval = vi.fn(async (_request: { displayReason?: { zh: string } }) => 'rejected')
  ctx.provide('sessions', { get: () => session } as never)
  ctx.provide('agents', { get: () => agent, list: () => [] } as never)
  ctx.provide('approval', { request: approval } as never)
  let scope!: ReturnType<typeof createScope>
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) },
    { inject: ['tools', 'sessions', 'agents', 'approval'] }))
  agent.ctx = scope.ctx
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ data: { name: '测试资料库' } }))
  vi.stubGlobal('fetch', fetcher)
  await ctx.plugin(G1brainIntegration, { baseUrl: 'http://127.0.0.1:19091', clientId: 'test', tenantId: '000000', timeoutMs: 1000 })
  const service = ctx.get('g1brain') as G1brainIntegration
  return { ctx, scope, session, agent, service, approval, fetcher, materials }
}

describe('bound G1brain Session tools', () => {
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
    const domains = await call('g1brain_list_ontology_domains', { collectionName: '测试本体' })
    expect(domains.isError).toBe(false)
    expect(parseJsonText(domains.content.find(block => block.type === 'text')?.text)).toEqual([{ name: '设备领域' }])
    const search = await call('g1brain_hybrid_search', { collectionName: '测试资料库', query: '设备' })
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
      mode: 'new-ontology', folderPath: materials, createOntologyCollectionName: '测试本体',
      createDomainName: '设备', createDocumentLibraryName: '测试资料库',
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

  it('requires confirm, matching targets, and an approval before a remote write', async () => {
    const { ctx, agent, service, session, materials, approval, fetcher } = await harness()
    await service.bindSession({ sessionId: session.id, target: {
      mode: 'new-ontology', folderPath: materials, createOntologyCollectionName: '测试本体',
      createDomainName: '设备', createDocumentLibraryName: '测试资料库',
    } })
    const call = (argumentsValue: object) => ctx.tools.execute({ signal: new AbortController().signal,
      callId: 'write-test' as never, name: 'g1brain_create_document_library', arguments: argumentsValue, agent: agent as never })
    expect((await call({ name: '测试资料库' })).isError).toBe(true)
    expect((await call({ name: '其他库', confirm: true })).isError).toBe(true)
    const denied = await call({ name: '测试资料库', confirm: true })
    expect(denied.isError).toBe(true)
    expect(approval).toHaveBeenCalledTimes(1)
    expect(fetcher).not.toHaveBeenCalled()
    approval.mockResolvedValueOnce('allowed-once')
    const allowed = await call({ name: '测试资料库', confirm: true })
    expect(allowed.isError).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('refuses to resume a bound Session with an inaccessible materials folder instead of silently losing its tools', async () => {
    const { ctx, agent, service, session, materials } = await harness()
    await service.bindSession({ sessionId: session.id, target: {
      mode: 'new-ontology', folderPath: materials, createOntologyCollectionName: '测试本体',
      createDomainName: '设备', createDocumentLibraryName: '测试资料库',
    } })
    rmSync(materials, { recursive: true })
    await expect(ctx.serial('agent/created', { agent: { ...agent } as never, source: 'resume' })).rejects.toThrow()
  })

  it('reuses one bounded approval for the same creation tool and target only', async () => {
    const { ctx, agent, service, session, materials, approval, fetcher } = await harness()
    await service.bindSession({ sessionId: session.id, target: {
      mode: 'new-ontology', folderPath: materials, createOntologyCollectionName: '测试本体',
      createDomainName: '设备', createDocumentLibraryName: '测试资料库',
    } })
    approval.mockResolvedValue('allowed-once')
    const property = (sid: string, confirm = true) => ctx.tools.execute({ signal: new AbortController().signal,
      callId: `property-${sid}` as never, name: 'g1brain_create_ontology_property',
      arguments: { collectionName: '测试本体', domainName: '设备', sid, displayName: sid,
        valueType: 'STRING', kind: 'SCALAR', confirm }, agent: agent as never })
    expect((await property('one')).isError).toBe(false)
    expect(approval).toHaveBeenCalledTimes(1)
    expect(approval.mock.calls[0]?.[0].displayReason?.zh).toContain('30 分钟内最多 100 次')
    expect((await property('two')).isError).toBe(false)
    expect(approval).toHaveBeenCalledTimes(1)
    expect((await property('three', false)).isError).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(2)
    const otherCreate = await ctx.tools.execute({ signal: new AbortController().signal,
      callId: 'other-create' as never, name: 'g1brain_create_document_library',
      arguments: { name: '测试资料库', confirm: true }, agent: agent as never })
    expect(otherCreate.isError).toBe(false)
    expect(approval).toHaveBeenCalledTimes(2)
    for (let index = 0; index < 98; index += 1) expect((await property(`more-${index}`)).isError).toBe(false)
    expect(approval).toHaveBeenCalledTimes(2)
    expect((await property('renew')).isError).toBe(false)
    expect(approval).toHaveBeenCalledTimes(3)
  })

  it('expires a creation grant after 30 minutes and never reuses it for deletions', async () => {
    const { ctx, agent, service, session, materials, approval } = await harness()
    await service.bindSession({ sessionId: session.id, target: {
      mode: 'new-ontology', folderPath: materials, createOntologyCollectionName: '测试本体',
      createDomainName: '设备', createDocumentLibraryName: '测试资料库',
    } })
    approval.mockResolvedValue('allowed-once')
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000)
    const call = (name: string, args: object) => ctx.tools.execute({ signal: new AbortController().signal,
      callId: name as never, name, arguments: args, agent: agent as never })
    const args = { collectionName: '测试本体', domainName: '设备', sid: 'serial', displayName: '序列号',
      valueType: 'STRING', kind: 'SCALAR', confirm: true }
    expect((await call('g1brain_create_ontology_property', args)).isError).toBe(false)
    now.mockReturnValue(10_000 + 30 * 60 * 1000 + 1)
    expect((await call('g1brain_create_ontology_property', { ...args, sid: 'serial2' })).isError).toBe(false)
    expect(approval).toHaveBeenCalledTimes(2)
    expect((await call('g1brain_delete_ontology_property', {
      collectionName: '测试本体', domainName: '设备', nodeId: 'property-1', confirm: true,
    })).isError).toBe(false)
    expect(approval).toHaveBeenCalledTimes(3)
    expect((await call('g1brain_delete_ontology_property', {
      collectionName: '测试本体', domainName: '设备', nodeId: 'property-2', confirm: true,
    })).isError).toBe(false)
    expect(approval).toHaveBeenCalledTimes(4)
    now.mockRestore()
  })

  it('shares one pending approval across parallel calls to the same creation tool', async () => {
    const { ctx, agent, service, session, materials, approval, fetcher } = await harness()
    await service.bindSession({ sessionId: session.id, target: {
      mode: 'new-ontology', folderPath: materials, createOntologyCollectionName: '测试本体',
      createDomainName: '设备', createDocumentLibraryName: '测试资料库',
    } })
    const decision = Promise.withResolvers<string>()
    approval.mockImplementationOnce(async () => decision.promise)
    const call = (sid: string) => ctx.tools.execute({ signal: new AbortController().signal,
      callId: `parallel-${sid}` as never, name: 'g1brain_create_ontology_property',
      arguments: { collectionName: '测试本体', domainName: '设备', sid, displayName: sid,
        valueType: 'STRING', kind: 'SCALAR', confirm: true }, agent: agent as never })
    const first = call('first')
    const second = call('second')
    await vi.waitFor(() => { expect(approval).toHaveBeenCalledTimes(1) })
    decision.resolve('allowed-once')
    const results = await Promise.all([first, second])
    expect(results.every(result => !result.isError)).toBe(true)
    expect(approval).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('uploads only a selected relative file after approval and rejects a path outside the materials directory', async () => {
    const { ctx, agent, service, session, materials, approval, fetcher } = await harness()
    writeFileSync(join(materials, 'evidence.md'), '# test evidence')
    await service.bindSession({ sessionId: session.id, target: {
      mode: 'new-ontology', folderPath: materials, createOntologyCollectionName: '测试本体',
      createDomainName: '设备', createDocumentLibraryName: '测试资料库',
    } })
    approval.mockResolvedValue('allowed-once')
    const invoke = (files: string[]) => ctx.tools.execute({ signal: new AbortController().signal,
      callId: 'upload-test' as never, name: 'g1brain_upload_selected_files',
      arguments: { collectionName: '测试资料库', files, confirm: true }, agent: agent as never })
    expect((await invoke(['../outside.md'])).isError).toBe(true)
    expect(approval).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
    const uploaded = await invoke(['evidence.md'])
    expect(uploaded.isError).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[0]).toContain('/mdApi/v1/md/collections/')
    expect(fetcher.mock.calls[0]?.[1].body).toBeInstanceOf(FormData)
  })

  it('submits MD and CHUNK processing tasks for files in the bound library with individual approvals', async () => {
    const { ctx, agent, service, session, materials, approval, fetcher } = await harness()
    await service.bindSession({ sessionId: session.id, target: {
      mode: 'new-ontology', folderPath: materials, createOntologyCollectionName: '测试本体',
      createDomainName: '设备', createDocumentLibraryName: '测试资料库',
    } })
    fetcher.mockImplementation(async (url) => {
      if (url.endsWith('/all')) return Response.json({ data: [{ id: 11 }, { id: 12 }] })
      if (url.endsWith('/tasks/submit')) return Response.json({ data: { taskId: 'task-created' } })
      throw new Error(`Unexpected request: ${url}`)
    })
    approval.mockResolvedValue('allowed-once')
    const submit = (argumentsValue: object) => ctx.tools.execute({ signal: new AbortController().signal,
      callId: 'task-submit' as never, name: 'g1brain_submit_document_task', arguments: argumentsValue, agent: agent as never })
    expect((await submit({ collectionName: '其他库', type: 'MD', fileSelection: 'all', confirm: true })).isError).toBe(true)
    expect(approval).not.toHaveBeenCalled()
    expect((await submit({ collectionName: '测试资料库', type: 'MD', fileSelection: 'all' })).isError).toBe(true)
    expect(approval).not.toHaveBeenCalled()
    expect((await submit({ collectionName: '测试资料库', type: 'MD', fileSelection: 'all', confirm: true })).isError).toBe(false)
    const firstBody = fetcher.mock.calls.find(([url]) => url.endsWith('/tasks/submit'))?.[1].body
    expect(parseJsonText(firstBody)).toEqual({ type: 'MD', operations: ['slice'], mdIds: [11, 12],
      mdType: 'simple', chunkMetadata: {}, chunkSize: 512 })
    expect((await submit({ collectionName: '测试资料库', type: 'CHUNK', fileSelection: 'selected', mdIds: [12],
      operations: ['keywords', 'vectorization', 'indexCreate'], confirm: true })).isError).toBe(false)
    expect((await submit({ collectionName: '测试资料库', type: 'CHUNK', fileSelection: 'selected', mdIds: [99],
      operations: ['indexCreate'], confirm: true })).isError).toBe(true)
    const submissions = fetcher.mock.calls.filter(([url]) => url.endsWith('/tasks/submit'))
    expect(submissions).toHaveLength(2)
    expect(parseJsonText(submissions[1]?.[1].body)).toEqual({ type: 'CHUNK', mdIds: [12],
      operations: ['keywords', 'vectorization', 'indexCreate'],
      embeddingMetadata: { keywords: 'keywords', llm_questions: 'faqs', _currentSectionToc: 'ToC', _heading: 'heading' },
      chunkMetadata: { _fileName: '文件名称', _currentSectionToc: '文档层级结构', _heading: '该段标题' },
      extraContent: [] })
    expect(approval).toHaveBeenCalledTimes(3)
  })

  it('reads compact task status, waits for a terminal task, and requires approval to cancel', async () => {
    const { ctx, agent, service, session, materials, approval, fetcher } = await harness()
    await service.bindSession({ sessionId: session.id, target: {
      mode: 'new-ontology', folderPath: materials, createOntologyCollectionName: '测试本体',
      createDomainName: '设备', createDocumentLibraryName: '测试资料库',
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
    const denied = await execute('g1brain_cancel_document_task', { collectionName: '测试资料库', taskId: 'task-1', confirm: true })
    expect(denied.isError).toBe(true)
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/cancel'))).toBe(false)
    approval.mockResolvedValueOnce('allowed-once')
    const cancelled = await execute('g1brain_cancel_document_task', { collectionName: '测试资料库', taskId: 'task-1', confirm: true })
    expect(cancelled.isError).toBe(false)
    expect(fetcher.mock.calls.find(([url]) => url.endsWith('/cancel'))?.[1].method).toBe('POST')
  })
})
