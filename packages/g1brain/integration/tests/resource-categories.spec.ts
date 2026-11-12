import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { G1BrainError } from '../src/legacy/errors.ts'
import { ResourceCategories, resourceImageProject } from '../src/legacy/g1brain/resource-categories.ts'
import type { ResourceImageProject } from '../src/legacy/types.ts'
import { pictureCategories } from './fixtures/picture-categories.ts'

const project: ResourceImageProject = { kind: 'ontology', collectionName: 'instruments', domainName: 'devices', displayName: '机电仪项目' }

function fixture() {
  const backend = pictureCategories()
  const send = vi.fn(async (path: string, init?: RequestInit): Promise<unknown> => {
    init?.signal?.throwIfAborted()
    return backend.response(new URL(path, 'http://test'), init?.method)
  })
  const config = { baseUrl: 'http://test', tenantId: 'tenant', parentId: '11', namespaceName: 'G1brain X DeepSeek', request: send }
  const resolver = new ResourceCategories(config)
  return { backend, send, config, resolver, writes: () => send.mock.calls.filter(([, init]) => init?.method === 'POST') }
}

describe('project picture categories', () => {
  it('creates the dedicated namespace and the project, never returning an ancestor', async () => {
    const f = fixture()
    expect(await f.resolver.project(project, 'user-123')).toBe('101')
    expect(f.backend.nodes).toMatchObject([
      { id: '11' }, { id: '100', parentId: '11', categoryName: 'G1brain X DeepSeek' },
      { id: '101', parentId: '100' },
    ])
    expect(f.backend.nodes[2]?.categoryName).toMatch(/^机电仪项目 \[g1brain_[a-f0-9]{64}\]$/u)
    expect(f.writes()).toHaveLength(2)
    for (const [path] of f.writes()) expect(new URL(path, 'http://test').searchParams.get('userId')).toBe('user-123')
  })

  it('reuses a stable server identity across clients, Sessions and changed display names', async () => {
    const f = fixture()
    const first = await f.resolver.project(project, 'user-123')
    const second = await new ResourceCategories(f.config).project({ ...project, displayName: '新的中文名称' }, 'user-123')
    expect(second).toBe(first)
    expect(f.writes()).toHaveLength(2)
  })

  it('isolates identical labels by ontology, domain, tenant, service and document-library kind', async () => {
    const f = fixture()
    const results = [await f.resolver.project(project, 'user-123')]
    results.push(await f.resolver.project({ ...project, collectionName: 'other' }, 'user-123'))
    results.push(await f.resolver.project({ ...project, domainName: 'other' }, 'user-123'))
    results.push(await new ResourceCategories({ ...f.config, tenantId: 'other' }).project(project, 'user-123'))
    results.push(await new ResourceCategories({ ...f.config, baseUrl: 'http://other' }).project(project, 'user-123'))
    results.push(await f.resolver.project({ kind: 'document-library', collectionName: 'instruments', displayName: project.displayName }, 'user-123'))
    expect(new Set(results).size).toBe(6)
    expect(f.backend.nodes.filter(node => node.parentId === '11')).toHaveLength(1)
  })

  it('serializes overlapping creates and lets a cancelled queued caller perform no writes', async () => {
    const f = fixture()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = f.send.getMockImplementation()!
    f.send.mockImplementation(async (path, init) => {
      if (init?.method === 'POST' && !f.backend.nodes.some(node => node.id === '100')) { entered.resolve(undefined); await release.promise }
      return original(path, init)
    })
    const first = f.resolver.project(project, 'user-123')
    await entered.promise
    const controller = new AbortController()
    const cancelled = f.resolver.project(project, 'user-123', controller.signal)
    const rejected = expect(cancelled).rejects.toThrow()
    const second = f.resolver.project(project, 'user-123')
    onTestFinished(async () => { release.resolve(undefined); await Promise.allSettled([first, cancelled, second]) })
    expect(f.writes()).toHaveLength(1)
    controller.abort()
    release.resolve(undefined)
    expect(await Promise.all([first, second])).toEqual(['101', '101'])
    await rejected
    expect(f.writes()).toHaveLength(2)
  })

  it('reconciles an accepted create whose response was lost without issuing a second POST', async () => {
    const f = fixture()
    const original = f.send.getMockImplementation()!
    let lost = false
    f.send.mockImplementation(async (path, init) => {
      const response = await original(path, init)
      if (init?.method === 'POST' && !lost) { lost = true; throw new Error('Connection lost') }
      return response
    })
    expect(await f.resolver.project(project, 'user-123')).toBe('101')
    expect(f.writes()).toHaveLength(2)
  })

  it('does not repeat an uncertain create or fall back to a root when readback finds no category', async () => {
    const f = fixture()
    const original = f.send.getMockImplementation()!
    f.send.mockImplementation(async (path, init) => {
      if (init?.method === 'POST') throw new Error('Connection lost before response')
      return original(path, init)
    })
    await expect(f.resolver.project(project, 'user-123')).rejects.toThrow('结果不确定')
    await expect(f.resolver.project(project, 'user-123')).rejects.toThrow('结果不确定')
    expect(f.writes()).toHaveLength(1)
    expect(f.backend.nodes).toHaveLength(1)
  })

  it('rejects denied creation and ambiguous categories without choosing a root', async () => {
    const f = fixture()
    const original = f.send.getMockImplementation()!
    f.send.mockImplementation(async (path, init) => {
      if (init?.method === 'POST') throw new G1BrainError('Forbidden', { status: 403 })
      return original(path, init)
    })
    await expect(f.resolver.project(project, 'user-123')).rejects.toThrow('Forbidden')
    f.backend.nodes.push({ id: '100', parentId: '11', categoryName: f.config.namespaceName, categoryType: 'picture' },
      { id: '101', parentId: '11', categoryName: f.config.namespaceName, categoryType: 'picture' })
    await expect(f.resolver.project(project, 'user-123')).rejects.toThrow('重复记录')
    expect(f.writes()).toHaveLength(1)
  })

  it('does not trust a successful create until the exact category can be read back', async () => {
    const f = fixture()
    const original = f.send.getMockImplementation()!
    f.send.mockImplementation(async (path, init) => init?.method === 'POST' ? true : original(path, init))
    await expect(f.resolver.project(project, 'user-123')).rejects.toThrow('结果不确定')
    await expect(f.resolver.project(project, 'user-123')).rejects.toThrow('结果不确定')
    expect(f.writes()).toHaveLength(1)
  })

  it('refuses an ancestor ID even when a malformed project record claims the correct name and parent', async () => {
    const f = fixture()
    await f.resolver.project(project, 'user-123')
    const name = f.backend.nodes[2]?.categoryName
    const original = f.send.getMockImplementation()!
    f.send.mockImplementation(async (path, init) => new URL(path, 'http://test').searchParams.get('id') === '100'
      ? { id: '100', childList: [{ id: '11', parentId: '100', categoryName: name }] } : original(path, init))
    await expect(f.resolver.project(project, 'user-123')).rejects.toThrow('不能使用图片根分类')
    expect(f.writes()).toHaveLength(2)
  })

  it.each([
    { id: '99', childList: [] },
    { id: '11', childList: {} },
    { id: '11', childList: [{ id: '12', parentId: '99', categoryName: 'foreign' }] },
    { id: '11', childList: [{ id: 9007199254740992, parentId: '11', categoryName: 'rounded' }] },
    { id: '11', childList: [{ id: '11', parentId: '11', categoryName: 'self' }] },
  ])('rejects malformed or foreign category records before creating anything: %j', async (response) => {
    const f = fixture()
    f.send.mockResolvedValue(response)
    await expect(f.resolver.project(project, 'user-123')).rejects.toThrow()
    expect(f.writes()).toHaveLength(0)
  })

  it('derives ontology scope from the binding, with a library-only fallback and no partial-binding fallback', () => {
    expect(resourceImageProject(undefined, '资料库')).toEqual({ kind: 'document-library', collectionName: '资料库', displayName: '资料库' })
    const task = { mode: 'update-ontology' as const, folderPath: '/materials', instruction: '', ontologyCollectionName: 'collection', domainName: 'domain' }
    expect(resourceImageProject(task, 'library', '显示领域')).toMatchObject({ kind: 'ontology', collectionName: 'collection', domainName: 'domain', displayName: '显示领域' })
    expect(() => resourceImageProject({ mode: task.mode, folderPath: task.folderPath,
      instruction: '', ontologyCollectionName: 'collection' }, 'library')).toThrow('缺少')
  })
})
