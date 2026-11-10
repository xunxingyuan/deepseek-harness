import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import G1brainIntegration from '@deepseek-ai/dsh-g1brain-integration'
import { installG1brainAuthentication } from '../src/g1brain-auth.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

class Channel extends EventEmitter {
  connected = true
  sent: object[] = []
  send(message: object, callback: (error: Error | null) => void): boolean {
    this.sent.push(message)
    callback(null)
    this.emit('sent', message)
    return true
  }
}

async function fixture(send: typeof fetch) {
  vi.stubEnv('G1BRAIN_AUTH_MODE', 'oauth')
  vi.stubEnv('G1BRAIN_CLIENT_SECRET', 'fixture-secret')
  vi.stubEnv('G1BRAIN_ACCESS_TOKEN', 'access-1')
  vi.stubEnv('G1BRAIN_USER_ID', 'user-1')
  vi.stubEnv('G1BRAIN_ACCESS_TOKEN_EXPIRES_AT', undefined)
  vi.stubGlobal('fetch', send)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide('sessions', { get: () => undefined } as never)
  ctx.provide('agents', { get: () => undefined, list: () => [] } as never)
  ctx.provide('approval', { request: async () => 'rejected' } as never)
  const fiber = await ctx.plugin(G1brainIntegration, { baseUrl: 'http://127.0.0.1:18203', clientId: 'client', tenantId: '000000', timeoutMs: 1000 })
  const channel = new Channel()
  installG1brainAuthentication(ctx, channel)
  return { ctx, channel, fiber, service: ctx.get('g1brain') as G1brainIntegration }
}

const credential = (accessToken = 'access-2', revision = 2) => ({ accessToken, userId: 'user-1', revision, expiresAt: Date.now() + 100000 })

describe('private G1brain authentication bridge', () => {
  it('requests one main-process renewal for concurrent catalog reads and never logs a refresh token', async () => {
    const send = vi.fn<typeof fetch>(async (_url, init) => new Headers(init?.headers).get('Blade-Auth') === 'bearer access-1'
      ? Response.json({ code: 401 }) : Response.json({ data: ['collection'] }))
    const { service, channel } = await fixture(send)
    const first = service.listOntologyCollections()
    const second = service.listDocumentLibraries()
    await vi.waitFor(() => { expect(channel.sent).toHaveLength(1) })
    expect(channel.sent[0]).toEqual({ type: 'g1brain-auth-refresh', requestId: 1, rejectedAccessToken: 'access-1' })
    channel.emit('message', { type: 'g1brain-auth-refreshed', requestId: 1, result: { kind: 'updated', credential: credential() } })
    expect(await Promise.all([first, second])).toEqual([[{ name: 'collection' }], [{ name: 'collection' }]])
    expect(channel.sent).toHaveLength(1)
    expect(JSON.stringify(channel.sent)).not.toContain('refresh_token')
  })

  it('uses proactive credential pushes and ignores stale or malformed updates without another process start', async () => {
    const send = vi.fn<typeof fetch>(async () => Response.json({ data: [] }))
    const { service, channel } = await fixture(send)
    channel.emit('message', { type: 'g1brain-auth-update', credential: credential() })
    channel.emit('message', { type: 'g1brain-auth-update', credential: credential('stale', 1) })
    channel.emit('message', { type: 'g1brain-auth-update', credential: { accessToken: 'invalid' } })
    channel.emit('message', { type: 'g1brain-auth-update', credential: credential('invalid\nheader', 999) })
    channel.emit('message', { type: 'g1brain-auth-update', credential: { ...credential('invalid-user', 999), userId: 'invalid\ruser' } })
    await service.listOntologyCollections()
    expect(new Headers(send.mock.calls[0]?.[1]?.headers).get('Blade-Auth')).toBe('bearer access-2')
    expect(channel.sent).toEqual([])
  })

  it('rebinds the latest access credential when the integration provider is replaced', async () => {
    const send = vi.fn<typeof fetch>(async () => Response.json({ data: [] }))
    const { ctx, channel, fiber } = await fixture(send)
    channel.emit('message', { type: 'g1brain-auth-update', credential: credential() })
    await fiber.dispose()
    await ctx.plugin(G1brainIntegration, { baseUrl: 'http://127.0.0.1:18203', clientId: 'client', tenantId: '000000', timeoutMs: 1000 })
    await Promise.resolve()
    await (ctx.get('g1brain') as G1brainIntegration).listOntologyCollections()
    expect(new Headers(send.mock.calls[0]?.[1]?.headers).get('Blade-Auth')).toBe('bearer access-2')
  })

  it('contains a mismatched identity update and keeps using the current credential', async () => {
    const send = vi.fn<typeof fetch>(async () => Response.json({ data: [] }))
    const { service, channel } = await fixture(send)
    channel.emit('message', { type: 'g1brain-auth-update', credential: credential() })
    expect(() => channel.emit('message', { type: 'g1brain-auth-update',
      credential: { ...credential('other-user-token', 3), userId: 'other-user' } })).not.toThrow()
    await service.listOntologyCollections()
    expect(new Headers(send.mock.calls[0]?.[1]?.headers).get('Blade-Auth')).toBe('bearer access-2')
  })

  it('settles renewal when the transport closes synchronously during send', async () => {
    const send = vi.fn<typeof fetch>(async () => Response.json({ code: 401 }))
    const { service, channel } = await fixture(send)
    channel.send = () => { throw new Error('channel closed') }
    await expect(service.listOntologyCollections()).rejects.toThrow('续期暂不可用')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('settles an outstanding renewal on disconnect and removes all listeners at disposal', async () => {
    const send = vi.fn<typeof fetch>(async () => Response.json({ code: 401 }))
    const { ctx, service, channel } = await fixture(send)
    const query = expect(service.listOntologyCollections()).rejects.toThrow('续期暂不可用')
    await vi.waitFor(() => { expect(channel.sent).toHaveLength(1) })
    channel.connected = false
    channel.emit('disconnect')
    await query
    await ctx.fiber.dispose()
    expect(channel.listenerCount('message')).toBe(0)
    expect(channel.listenerCount('disconnect')).toBe(0)
    channel.emit('message', { type: 'g1brain-auth-refreshed', requestId: 1, result: { kind: 'updated', credential: credential() } })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('returns unavailable after its own bounded IPC deadline without logging the user out', async () => {
    vi.useFakeTimers()
    const send = vi.fn<typeof fetch>(async () => Response.json({ code: 401 }))
    const { ctx, service, channel } = await fixture(send)
    const expired = vi.fn()
    ctx.on('g1brain/auth-expired', expired)
    const query = expect(service.listOntologyCollections()).rejects.toThrow('续期暂不可用')
    await vi.waitFor(() => { expect(channel.sent).toHaveLength(1) })
    await vi.advanceTimersByTimeAsync(30001)
    await query
    expect(expired).not.toHaveBeenCalled()
  })
})
