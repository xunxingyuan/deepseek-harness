import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_G1BRAIN_DEV_BASE_URL, DEFAULT_G1BRAIN_TABLE_DEV_BASE_URL, G1brainAuth, g1brainDevelopmentHostEnvironment } from '../src/g1brain-auth.ts'

afterEach(() => { vi.useRealTimers() })

describe('G1brain desktop login', () => {
  it('clears local sign-in without deleting connection or model settings', async () => {
    const auth = new G1brainAuth(() => ({}))
    await auth.login('admin', 'fixture-password')
    expect(auth.signedIn).toBe(true)
    auth.signOut()
    expect(auth.signedIn).toBe(false)
    expect(await auth.login('second', 'fixture-password')).toEqual({ ok: true, username: 'second' })
  })

  it('does not restore OAuth credentials when an old response arrives after sign-out', async () => {
    const response = Promise.withResolvers<Response>()
    const auth = new G1brainAuth(() => ({ G1BRAIN_AUTH_MODE: 'oauth', G1BRAIN_CLIENT_SECRET: 'fixture-secret' }),
      async (_input, init) => { expect(init?.redirect).toBe('error'); return response.promise })
    const login = auth.login('admin', 'fixture-password')
    auth.signOut()
    response.resolve(Response.json({ access_token: 'stale-token', expires_in: 3600 }))
    expect(await login).toEqual({ ok: false, reason: 'unavailable' })
    expect(auth.signedIn).toBe(false)
  })

  it('connects the unpackaged development Host with the existing G1brain development API identity', () => {
    expect(g1brainDevelopmentHostEnvironment({}, true, 'local-dev')).toEqual({
      G1BRAIN_BASE_URL: DEFAULT_G1BRAIN_DEV_BASE_URL,
      G1BRAIN_TABLE_BASE_URL: DEFAULT_G1BRAIN_TABLE_DEV_BASE_URL,
      G1BRAIN_LOCAL_USER_ID: 'developer',
      G1BRAIN_LOCAL_CLIENT_ID: 'g1brain-web',
      G1BRAIN_ALLOW_LOCAL_DEV: '1',
      G1BRAIN_ALLOW_DEV_WRITES: '1',
    })
    expect(g1brainDevelopmentHostEnvironment({ G1BRAIN_BASE_URL: 'http://127.0.0.1:9000' }, true, 'local-dev').G1BRAIN_BASE_URL)
      .toBe('http://127.0.0.1:9000')
    expect(g1brainDevelopmentHostEnvironment({ G1BRAIN_TABLE_BASE_URL: 'http://127.0.0.1:8091' }, true, 'local-dev').G1BRAIN_TABLE_BASE_URL)
      .toBe('http://127.0.0.1:8091')
    expect(g1brainDevelopmentHostEnvironment({}, false, 'local-dev')).toEqual({})
    expect(g1brainDevelopmentHostEnvironment({}, true, 'oauth')).toEqual({})
  })
  it.each(['win32', 'darwin'] as const)('connects an installed unsigned %s test package without shell configuration', async (platform) => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const manifest = createElectronBuilderConfig({ DSH_DESKTOP_UNSIGNED: '1' }, platform, 'x64').extraMetadata
    const auth = new G1brainAuth(() => ({}), vi.fn<typeof fetch>())
    expect(await auth.login('admin', 'fixture-password')).toEqual({ ok: true, username: 'admin' })
    expect(g1brainDevelopmentHostEnvironment({}, false, auth.mode, manifest)).toEqual({
      G1BRAIN_BASE_URL: DEFAULT_G1BRAIN_DEV_BASE_URL,
      G1BRAIN_TABLE_BASE_URL: DEFAULT_G1BRAIN_TABLE_DEV_BASE_URL,
      G1BRAIN_LOCAL_USER_ID: 'developer',
      G1BRAIN_LOCAL_CLIENT_ID: 'g1brain-web',
      G1BRAIN_ALLOW_LOCAL_DEV: '1',
      G1BRAIN_ALLOW_DEV_WRITES: '1',
    })
    expect(g1brainDevelopmentHostEnvironment({ G1BRAIN_BASE_URL: 'http://127.0.0.1:9000', G1BRAIN_ALLOW_DEV_WRITES: '0' }, false, auth.mode, manifest))
      .toMatchObject({ G1BRAIN_BASE_URL: 'http://127.0.0.1:9000', G1BRAIN_ALLOW_DEV_WRITES: '0' })
    expect(g1brainDevelopmentHostEnvironment({}, false, 'oauth', manifest)).toEqual({})
  })

  it.each([undefined, null, {}, { g1brainDevelopmentConnection: false }, { g1brainDevelopmentConnection: 'true' }])('requires an explicit test-package connection marker (%j)', (manifest) => {
    expect(g1brainDevelopmentHostEnvironment({}, false, 'local-dev', manifest)).toEqual({})
  })

  it('opens a development session without transmitting or retaining the password', async () => {
    const send = vi.fn<typeof fetch>()
    const auth = new G1brainAuth(() => ({}), send)
    expect(auth.signedIn).toBe(false)
    expect(await auth.login(' admin ', 'test-password')).toEqual({ ok: true, username: 'admin' })
    expect(auth.signedIn).toBe(true)
    expect(send).not.toHaveBeenCalled()
    expect(Object.values(auth)).not.toContain('test-password')
  })

  it('requires both fields before accepting a development login', async () => {
    const auth = new G1brainAuth(() => ({}))
    expect(await auth.login('', 'password')).toEqual({ ok: false, reason: 'invalid-credentials' })
    expect(await auth.login('admin', '')).toEqual({ ok: false, reason: 'invalid-credentials' })
    expect(auth.signedIn).toBe(false)
  })

  it('uses the G1brain OAuth exchange only when that mode is explicitly configured', async () => {
    const send = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { access_token: 'server-token', user_id: 'user-1', expires_in: 3600 } }), { status: 200 }))
    const auth = new G1brainAuth(() => ({ G1BRAIN_AUTH_MODE: 'oauth', G1BRAIN_CLIENT_SECRET: 'fixture-secret' }), send)
    expect(await auth.login('alice', 'fixture-password')).toEqual({ ok: true, username: 'alice' })
    expect(auth.signedIn).toBe(true)
    const [url, init] = send.mock.calls[0]!
    expect(url instanceof URL ? url.href : typeof url === 'string' ? url : url.url)
      .toBe('http://192.168.100.113:19091/api/blade-auth/oauth/token')
    expect(init?.method).toBe('POST')
    expect(typeof init?.body).toBe('string')
    const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '')
    expect(form.get('username')).toBe('alice')
    expect(form.get('tenantId')).toBe('000000')
    expect(form.get('password')).not.toBe('fixture-password')
    expect(form.get('password')).toMatch(/^[0-9a-f]+$/u)
    expect(init?.headers).toMatchObject({ 'User-Type': 'app', 'Tenant-Id': '000000' })
    expect(auth.hostEnvironment()).toMatchObject({ G1BRAIN_ACCESS_TOKEN: 'server-token', G1BRAIN_USER_ID: 'user-1', G1BRAIN_REFRESH_TOKEN: undefined })
    auth.signOut()
    expect(auth.hostEnvironment().G1BRAIN_ACCESS_TOKEN).toBeUndefined()
  })

  it('rejects an unconfigured or refused OAuth exchange without opening a session', async () => {
    const missing = new G1brainAuth(() => ({ G1BRAIN_AUTH_MODE: 'oauth' }))
    expect(await missing.login('alice', 'password')).toEqual({ ok: false, reason: 'missing-config' })
    const refused = new G1brainAuth(() => ({ G1BRAIN_AUTH_MODE: 'oauth', G1BRAIN_CLIENT_SECRET: 'fixture' }),
      vi.fn<typeof fetch>(async () => new Response('{}', { status: 401 })))
    expect(await refused.login('alice', 'password')).toEqual({ ok: false, reason: 'invalid-credentials' })
    expect(refused.signedIn).toBe(false)
  })

  it('reads authenticated user information when the token exchange omits user_id', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: 'fixture-token' }))
      .mockResolvedValueOnce(Response.json({ code: 200, data: { id: 'user-info-id' } }))
    const auth = new G1brainAuth(() => ({ G1BRAIN_AUTH_MODE: 'oauth', G1BRAIN_CLIENT_SECRET: 'fixture-secret' }), send)
    expect(await auth.login('alice', 'fixture-password')).toEqual({ ok: true, username: 'alice' })
    expect(send.mock.calls[1]?.[1]?.headers).toMatchObject({ 'Blade-Auth': 'bearer fixture-token' })
    expect(auth.hostEnvironment().G1BRAIN_USER_ID).toBe('user-info-id')
    auth.signOut()
  })

  it.each([401, '401'])('rejects business-code %s even when the payload contains stale credentials', async (code) => {
    const environment = () => ({ G1BRAIN_AUTH_MODE: 'oauth', G1BRAIN_CLIENT_ID: 'configured-client', G1BRAIN_CLIENT_SECRET: 'configured-secret' })
    const refused = new G1brainAuth(environment, async () => Response.json({ code,
      data: { access_token: 'stale-token', user_id: 'user-1' } }))
    expect(await refused.login('alice', 'password')).toEqual({ ok: false, reason: 'invalid-credentials' })
    expect(refused.signedIn).toBe(false)
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: 'fixture-token' }))
      .mockResolvedValueOnce(Response.json({ code, data: { id: 'stale-user' } }))
    const userInfo = new G1brainAuth(environment, send)
    expect(await userInfo.login('alice', 'password')).toEqual({ ok: false, reason: 'invalid-credentials' })
    expect(userInfo.signedIn).toBe(false)
  })

  it('expires short-lived tokens once and does not reuse inherited credentials after sign-out', async () => {
    vi.useFakeTimers()
    const expired = vi.fn()
    const auth = new G1brainAuth(() => ({ G1BRAIN_AUTH_MODE: 'oauth', G1BRAIN_CLIENT_SECRET: 'fixture-secret', G1BRAIN_ACCESS_TOKEN: 'old-env-token' }),
      async () => Response.json({ access_token: 'fixture-token', user_id: 'user-1', expires_in: 32 }), expired)
    const initial = auth.sessionGeneration
    expect(await auth.login('alice', 'fixture-password')).toEqual({ ok: true, username: 'alice' })
    expect(auth.sessionGeneration).toBeGreaterThan(initial)
    expect(auth.hostEnvironment().G1BRAIN_ACCESS_TOKEN).toBe('fixture-token')
    await vi.advanceTimersByTimeAsync(2000)
    expect(auth.signedIn).toBe(false)
    expect(expired).toHaveBeenCalledTimes(1)
    expect(auth.expire()).toBe(false)
    expect(auth.hostEnvironment().G1BRAIN_ACCESS_TOKEN).toBeUndefined()
    expect(auth.hostEnvironment().G1BRAIN_USER_ID).toBeUndefined()
  })

  it('does not notify expiry after manual sign-out or restore a late user-info response', async () => {
    vi.useFakeTimers()
    const info = Promise.withResolvers<Response>()
    const expired = vi.fn()
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: 'fixture-token', expires_in: 32 }))
      .mockImplementationOnce(async () => info.promise)
    const auth = new G1brainAuth(() => ({ G1BRAIN_AUTH_MODE: 'oauth', G1BRAIN_CLIENT_SECRET: 'fixture-secret' }), send, expired)
    const login = auth.login('alice', 'fixture-password')
    await vi.waitFor(() => { expect(send).toHaveBeenCalledTimes(2) })
    auth.signOut()
    info.resolve(Response.json({ data: { id: 'user-1' } }))
    expect(await login).toEqual({ ok: false, reason: 'unavailable' })
    await vi.advanceTimersByTimeAsync(4000)
    expect(expired).not.toHaveBeenCalled()
    expect(auth.signedIn).toBe(false)
  })
})
