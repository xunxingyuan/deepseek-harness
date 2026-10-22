import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_G1BRAIN_DEV_BASE_URL, DEFAULT_G1BRAIN_TABLE_DEV_BASE_URL, G1brainAuth, g1brainDevelopmentHostEnvironment } from '../src/g1brain-auth.ts'

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
    const send = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { access_token: 'server-token', expires_in: 3600 } }), { status: 200 }))
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
  })

  it('rejects an unconfigured or refused OAuth exchange without opening a session', async () => {
    const missing = new G1brainAuth(() => ({ G1BRAIN_AUTH_MODE: 'oauth' }))
    expect(await missing.login('alice', 'password')).toEqual({ ok: false, reason: 'missing-config' })
    const refused = new G1brainAuth(() => ({ G1BRAIN_AUTH_MODE: 'oauth', G1BRAIN_CLIENT_SECRET: 'fixture' }),
      vi.fn<typeof fetch>(async () => new Response('{}', { status: 401 })))
    expect(await refused.login('alice', 'password')).toEqual({ ok: false, reason: 'invalid-credentials' })
    expect(refused.signedIn).toBe(false)
  })
})
