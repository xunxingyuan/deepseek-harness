import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { G1brainPreparationError, prepareG1brainSession } from '../src/client/preparation.ts'
import type { G1brainSessionTarget } from '@deepseek-ai/dsh-g1brain-integration/types'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

const input = { target: { mode: 'new-ontology', folderPath: 'C:\\Users\\lisa\\Downloads\\周报本体',
  createOntologyCollectionName: '周报本体', createDomainName: '周报领域', createDocumentLibraryName: '周报文档库' } satisfies G1brainSessionTarget,
prompt: '请盘点材料，并用中文提出构建方案。' }

function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  const calls: string[] = []
  const binding = { sessionId: 'session-g1brain-preparation' }
  const createWorkspace = vi.fn(async (_input: { path: string }) => { calls.push('workspace'); return { workspaceId: 'workspace-materials' } })
  const createSession = vi.fn(async (_input: { workspaceId: string }) => { calls.push('session'); return binding.sessionId })
  const bind = vi.fn(async (_input: object) => { calls.push('binding'); return { ok: true, value: { bound: true } } })
  const release = vi.fn(() => { calls.push('release') })
  const reference = { binding, ready: Promise.resolve(binding), release }
  const retain = vi.fn(() => { calls.push('retain'); return reference })
  const draft = vi.fn<(...args: unknown[]) => string>(() => { calls.push('draft'); return 'applied' })
  const open = vi.fn(() => { calls.push('open') })
  ctx.provide('workspaces', { create: createWorkspace } as never)
  ctx.provide('sessions', { create: createSession, retain } as never)
  ctx.provide('remote', { g1brain: { bindSession: bind } } as never)
  ctx.provide('conversation', { input: { requestDraftInitialization: draft } } as never)
  ctx.provide('uiWorkspace', { openSession: open } as never)
  return { ctx, calls, binding, createWorkspace, createSession, bind, retain, reference, release, draft, open }
}

describe('G1brain Session preparation', () => {
  it('waits for the retained Session before preparing its draft and navigating', async () => {
    const f = fixture()
    const ready = Promise.withResolvers<typeof f.binding>()
    f.reference.ready = ready.promise
    const preparing = prepareG1brainSession(f.ctx, input)
    onTestFinished(async () => { ready.resolve(f.binding); await preparing })
    await vi.waitFor(() => { expect(f.retain).toHaveBeenCalledTimes(1) })
    expect(f.draft).not.toHaveBeenCalled()
    expect(f.open).not.toHaveBeenCalled()
    ready.resolve(f.binding)
    await preparing
    expect(f.createWorkspace).toHaveBeenCalledWith({ path: input.target.folderPath })
    expect(f.bind).toHaveBeenCalledWith({ sessionId: f.binding.sessionId, target: input.target })
    expect(f.draft).toHaveBeenCalledWith(f.binding, { prompt: input.prompt })
    expect(f.calls).toEqual(['workspace', 'session', 'binding', 'retain', 'draft', 'open', 'release'])
  })

  it('reports directory access failures before creating a Session', async () => {
    const f = fixture()
    f.createWorkspace.mockRejectedValue(new Error('fixture directory denied'))
    await expect(prepareG1brainSession(f.ctx, input)).rejects.toMatchObject({ stage: 'directory' })
    expect(f.createSession).not.toHaveBeenCalled()
    expect(f.open).not.toHaveBeenCalled()
  })

  it('reports Session creation failures without treating them as a missing folder', async () => {
    const f = fixture()
    f.createSession.mockRejectedValue(new Error('fixture Session unavailable'))
    await expect(prepareG1brainSession(f.ctx, input)).rejects.toMatchObject({ stage: 'session' })
    expect(f.bind).not.toHaveBeenCalled()
    expect(f.open).not.toHaveBeenCalled()
  })

  it('never opens an unbound Session when G1brain binding fails', async () => {
    const f = fixture()
    f.bind.mockRejectedValue(new Error('fixture binding failed'))
    await expect(prepareG1brainSession(f.ctx, input)).rejects.toBeInstanceOf(G1brainPreparationError)
    expect(f.retain).not.toHaveBeenCalled()
    expect(f.open).not.toHaveBeenCalled()
  })

  it('classifies a refused Remote binding and does not initialize an ordinary Session draft', async () => {
    const f = fixture()
    f.bind.mockResolvedValue({ ok: false, error: { message: 'fixture binding refused' } } as never)
    await expect(prepareG1brainSession(f.ctx, input)).rejects.toMatchObject({ stage: 'binding' })
    expect(f.draft).not.toHaveBeenCalled()
    expect(f.open).not.toHaveBeenCalled()
  })

  it.each(['blocked', 'preserved'])('retains the form and releases the Session if draft initialization is %s', async (result) => {
    const f = fixture()
    f.draft.mockReturnValue(result)
    await expect(prepareG1brainSession(f.ctx, input)).rejects.toMatchObject({ stage: 'draft' })
    expect(f.release).toHaveBeenCalledTimes(1)
    expect(f.open).not.toHaveBeenCalled()
  })

  it('releases a retained Session when its initial opening fails', async () => {
    const f = fixture()
    const ready = Promise.withResolvers<typeof f.binding>()
    f.reference.ready = ready.promise
    const preparing = prepareG1brainSession(f.ctx, input)
    const rejected = expect(preparing).rejects.toMatchObject({ stage: 'draft' })
    await vi.waitFor(() => { expect(f.retain).toHaveBeenCalledTimes(1) })
    ready.reject(new Error('fixture history open failed'))
    await rejected
    expect(f.release).toHaveBeenCalledTimes(1)
    expect(f.open).not.toHaveBeenCalled()
  })
})
