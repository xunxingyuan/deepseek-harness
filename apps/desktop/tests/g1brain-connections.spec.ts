import { mkdtemp, readFile, rm, symlink, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { G1brainConnectionStore, parseG1brainConnections } from '../src/g1brain-connections.ts'

const roots: string[] = []
const credentials = { clientId: 'lhzstp', clientSecret: '' }
const key = randomBytes(32)
const cipher = {
  available: () => true,
  encrypt(value: string) {
    const nonce = randomBytes(12)
    const encryptor = createCipheriv('aes-256-gcm', key, nonce)
    const payload = Buffer.concat([encryptor.update(value, 'utf8'), encryptor.final()])
    return Buffer.concat([nonce, encryptor.getAuthTag(), payload])
  },
  decrypt(value: Buffer) {
    const decryptor = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
    decryptor.setAuthTag(value.subarray(12, 28))
    return Buffer.concat([decryptor.update(value.subarray(28)), decryptor.final()]).toString('utf8')
  },
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'g1brain-connections-'))
  roots.push(root)
  const path = join(root, 'connections.json')
  return { path, store: new G1brainConnectionStore(path, cipher) }
}

describe('G1brain connection preferences', () => {
  it('keeps first-run defaults external and persists only normalized service roots', async () => {
    const { path, store } = await fixture()
    expect(await store.load()).toBeUndefined()
    const settings = parseG1brainConnections({ baseUrl: ' http://server.test:19091/ ', tableBaseUrl: '', ...credentials })
    expect(settings).toEqual({ baseUrl: 'http://server.test:19091', tableBaseUrl: '', ...credentials })
    await store.save(settings)
    expect(await new G1brainConnectionStore(path).load()).toEqual(settings)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 2,
      settings: { baseUrl: settings.baseUrl, tableBaseUrl: '', clientId: credentials.clientId }, clientSecretEncrypted: '' })
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it.each(['', '192.168.0.1:19091', 'file:///tmp/a', 'javascript:alert(1)',
    'http://user:password@server.test', 'https://server.test/?token=secret', 'https://server.test/#fragment'])('rejects unsafe address %s', (baseUrl) => {
    expect(() => parseG1brainConnections({ baseUrl, tableBaseUrl: '', ...credentials })).toThrow()
    expect(() => parseG1brainConnections({ baseUrl: 'https://server.test', tableBaseUrl: baseUrl || 'invalid', ...credentials })).toThrow()
  })

  it('rejects malformed input and corrupted or future preference records', async () => {
    const { path, store } = await fixture()
    expect(() => parseG1brainConnections({ baseUrl: 'http://server.test', tableBaseUrl: '', password: 'secret' })).toThrow()
    await writeFile(path, '{not-json')
    await expect(store.load()).rejects.toThrow()
    await writeFile(path, JSON.stringify({ version: 3, settings: { baseUrl: 'http://server.test', tableBaseUrl: '' } }))
    await expect(store.load()).rejects.toThrow('Unsupported')
  })

  it('encrypts, retains and rotates the secret without writing it into settings', async () => {
    const { path, store } = await fixture()
    const settings = { baseUrl: 'http://server.test', tableBaseUrl: '', clientId: 'lhzstp', clientSecret: 'private-client-secret' }
    await store.save(settings)
    expect(await readFile(path, 'utf8')).not.toContain(settings.clientSecret)
    expect(await new G1brainConnectionStore(path, cipher).load()).toEqual(settings)
    await store.save({ ...settings, clientSecret: '' })
    expect(await store.load()).toEqual(settings)
    await store.save({ ...settings, clientSecret: 'replacement' })
    expect((await store.load())?.clientSecret).toBe('replacement')
    const previous = await readFile(path, 'utf8')
    await expect(new G1brainConnectionStore(path, { ...cipher, available: () => false }).save(settings)).rejects.toThrow('unavailable')
    expect(await readFile(path, 'utf8')).toBe(previous)
  })

  it('migrates URL-only preferences and encrypts a supplied deployment default', async () => {
    const { path, store } = await fixture()
    const settings = { baseUrl: 'http://server.test', tableBaseUrl: '' }
    await writeFile(path, JSON.stringify({ version: 1, settings }))
    expect(await store.load()).toEqual({ ...settings, ...credentials })
    await store.save({ ...settings, ...credentials }, 'deployment-default')
    expect((await store.load())?.clientSecret).toBe('deployment-default')
    expect(await readFile(path, 'utf8')).not.toContain('deployment-default')
  })

  it('rejects malformed credentials and ciphertext instead of silently using development mode', async () => {
    const { path, store } = await fixture()
    const settings = { baseUrl: 'http://server.test', tableBaseUrl: '', ...credentials }
    for (const clientId of ['', 'a:b', 'a\nb', 'x'.repeat(257)]) {
      expect(() => parseG1brainConnections({ ...settings, clientId })).toThrow()
    }
    expect(() => parseG1brainConnections({ ...settings, clientSecret: 'x'.repeat(4097) })).toThrow()
    await writeFile(path, JSON.stringify({ version: 2, settings: { baseUrl: settings.baseUrl, tableBaseUrl: '', clientId: 'lhzstp' },
      clientSecretEncrypted: Buffer.from('corrupt-ciphertext').toString('base64') }))
    await expect(store.load()).rejects.toThrow('decrypt')
  })

  it.skipIf(process.platform === 'win32')('refuses a symlinked preference file', async () => {
    const { path, store } = await fixture()
    await symlink(join(tmpdir(), 'unrelated'), path)
    await expect(store.load()).rejects.toThrow('Invalid connection')
  })
})
