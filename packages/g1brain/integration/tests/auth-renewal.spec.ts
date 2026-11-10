import { describe, expect, it, vi } from 'vitest'
import { createG1BrainClient } from '../src/legacy/g1brain/client.ts'
import type { AuthTokens } from '../src/legacy/types.ts'

const tokens = (accessToken = 'access-one', expiresAt = Date.now() + 60000): AuthTokens => ({
  accessToken, userId: 'user-one', expiresAt, tenantId: '000000', issuedAt: Date.now(),
})

function fixture() {
  const fetcher = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => Response.json({ data: [] }))
  const expired = vi.fn()
  const renew = vi.fn(async (_token?: string) => {
    client.setTokens(tokens('access-two'))
    return true
  })
  const client = createG1BrainClient({ baseUrl: 'http://localhost', authMode: 'oauth', clientId: 'test', clientSecret: 'fixture',
    tenantId: '000000', publicKey: '', timeoutMs: 1000, localUserId: '', localClientId: '',
    renewAuthentication: renew, onAuthExpired: expired }, fetcher)
  client.setTokens(tokens())
  return { client, fetcher, renew, expired }
}

describe('G1brain tool-client renewal', () => {
  it.each(['http', 'business'])('renews and replays a rejected read once (%s)', async (kind) => {
    const { client, fetcher, renew, expired } = fixture()
    fetcher.mockResolvedValueOnce(kind === 'http' ? Response.json({}, { status: 401 }) : Response.json({ code: 401 }))
    await client.listMdLibraries()
    expect(renew).toHaveBeenCalledExactlyOnceWith('access-one')
    expect(fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get('Blade-Auth')))
      .toEqual(['bearer access-one', 'bearer access-two'])
    expect(expired).not.toHaveBeenCalled()
  })

  it('renews a rejected write without replaying it and lets the next read use the fresh credential', async () => {
    const { client, fetcher, renew, expired } = fixture()
    fetcher.mockResolvedValueOnce(Response.json({}, { status: 401 }))
    await expect(client.createMdLibrary('test')).rejects.toThrow('当前请求未自动重发')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(renew).toHaveBeenCalledExactlyOnceWith('access-one')
    await client.listMdLibraries()
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('Blade-Auth')).toBe('bearer access-two')
    expect(expired).not.toHaveBeenCalled()
  })

  it('does not loop or expire a renewed login when the replay is also rejected', async () => {
    const { client, fetcher, renew, expired } = fixture()
    fetcher.mockImplementation(async () => Response.json({}, { status: 401 }))
    await expect(client.listMdLibraries()).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(renew).toHaveBeenCalledTimes(1)
    expect(expired).not.toHaveBeenCalled()
  })

  it('renews an expired access token before sending the first write', async () => {
    const { client, fetcher, renew } = fixture()
    client.setTokens(tokens('access-one', Date.now() - 1))
    await client.createMdLibrary('test')
    expect(renew).toHaveBeenCalledExactlyOnceWith('access-one')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('Blade-Auth')).toBe('bearer access-two')
  })

  it('does not send expired credentials during an outage or send a cancelled write after renewal', async () => {
    const { client, fetcher, renew, expired } = fixture()
    client.setTokens(tokens('access-one', Date.now() - 1))
    renew.mockRejectedValueOnce(new Error('temporarily unavailable'))
    await expect(client.listMdLibraries()).rejects.toThrow('temporarily unavailable')
    expect(fetcher).not.toHaveBeenCalled()
    expect(expired).not.toHaveBeenCalled()
    const controller = new AbortController()
    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    renew.mockImplementationOnce(async () => { await barrier; return true })
    const operation = client.uploadMdFile('library', 'test.md', '# test', controller.signal)
    const rejected = expect(operation).rejects.toThrow()
    controller.abort()
    release()
    await rejected
    expect(fetcher).not.toHaveBeenCalled()
  })
})
