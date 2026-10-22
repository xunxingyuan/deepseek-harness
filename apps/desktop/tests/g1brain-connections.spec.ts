import { mkdtemp, readFile, rm, symlink, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { G1brainConnectionStore, parseG1brainConnections } from '../src/g1brain-connections.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'g1brain-connections-'))
  roots.push(root)
  const path = join(root, 'connections.json')
  return { path, store: new G1brainConnectionStore(path) }
}

describe('G1brain connection preferences', () => {
  it('keeps first-run defaults external and persists only normalized service roots', async () => {
    const { path, store } = await fixture()
    expect(await store.load()).toBeUndefined()
    const settings = parseG1brainConnections({ baseUrl: ' http://server.test:19091/ ', tableBaseUrl: '' })
    expect(settings).toEqual({ baseUrl: 'http://server.test:19091', tableBaseUrl: '' })
    await store.save(settings)
    expect(await new G1brainConnectionStore(path).load()).toEqual(settings)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, settings })
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it.each(['', '192.168.0.1:19091', 'file:///tmp/a', 'javascript:alert(1)',
    'http://user:password@server.test', 'https://server.test/?token=secret', 'https://server.test/#fragment'])('rejects unsafe address %s', (baseUrl) => {
    expect(() => parseG1brainConnections({ baseUrl, tableBaseUrl: '' })).toThrow()
    expect(() => parseG1brainConnections({ baseUrl: 'https://server.test', tableBaseUrl: baseUrl || 'invalid' })).toThrow()
  })

  it('rejects malformed input and corrupted or future preference records', async () => {
    const { path, store } = await fixture()
    expect(() => parseG1brainConnections({ baseUrl: 'http://server.test', tableBaseUrl: '', password: 'secret' })).toThrow()
    await writeFile(path, '{not-json')
    await expect(store.load()).rejects.toThrow()
    await writeFile(path, JSON.stringify({ version: 2, settings: { baseUrl: 'http://server.test', tableBaseUrl: '' } }))
    await expect(store.load()).rejects.toThrow('Unsupported')
  })

  it.skipIf(process.platform === 'win32')('refuses a symlinked preference file', async () => {
    const { path, store } = await fixture()
    await symlink(join(tmpdir(), 'unrelated'), path)
    await expect(store.load()).rejects.toThrow('Invalid connection')
  })
})
