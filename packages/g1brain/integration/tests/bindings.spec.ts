import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { createBindingStore } from '../src/bindings.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'g1brain-binding-test-'))
  roots.push(root)
  const directory = join(root, 'materials')
  mkdirSync(directory)
  const session = { id: SessionId('session-test'), header: { cwd: directory } }
  const store = createBindingStore(join(root, 'bindings'))
  const target = { mode: 'new-ontology' as const, folderPath: directory,
    createOntologyCollectionName: '新本体', createDocumentLibraryName: '新文档库', createDomainName: '设备' }
  return { root, directory, session, store, target }
}

describe('G1brain Session bindings', () => {
  it('persists a canonical target and refuses a different target for the same Session', async () => {
    const { directory, session, store, target } = fixture()
    const canonical = { ...target, folderPath: realpathSync(directory) }
    expect(await store.bind(session, target)).toEqual(canonical)
    expect(await store.load(session)).toEqual(canonical)
    await expect(store.bind(session, { ...target, createOntologyCollectionName: '另一集合' }))
      .rejects.toThrow('already bound')
  })

  it('rejects a selected directory outside the Session Workspace and invalid target pairs', async () => {
    const { root, session, store, target } = fixture()
    const other = join(root, 'other')
    mkdirSync(other)
    await expect(store.bind(session, { ...target, folderPath: other })).rejects.toThrow('differs')
    await expect(store.bind(session, { ...target, ontologyCollectionName: '已有集合' })).rejects.toThrow('mode')
    await expect(store.bind(session, { ...target, documentLibraryName: '已有文档库' })).rejects.toThrow('exactly one')
    await expect(store.bind(session, { mode: 'new-ontology', folderPath: target.folderPath,
      createOntologyCollectionName: '新本体', createDocumentLibraryName: '新文档库' })).rejects.toThrow('domain target')
  })

  it('keeps an unrelated Session unbound', async () => {
    const { directory, store } = fixture()
    expect(await store.load({ id: SessionId('session-other'), header: { cwd: directory } })).toBeUndefined()
  })
})
