/** G1brain password authentication owned by the Electron main process. */

import { Buffer } from 'node:buffer'
import md5 from 'js-md5'
import { sm2 } from 'sm-crypto'

const DEFAULT_PUBLIC_KEY = '0445d8d7059501ed8f96f3b8baa4215bd215ef1e67a923a73da60939984384d979c3025ba7ee4340e1bec0817a19636cadea7c34e80155ee55476fdeb62465199a'

/** Existing G1brain development API, used only by an unpackaged local-development desktop. */
export const DEFAULT_G1BRAIN_DEV_BASE_URL = 'http://192.168.100.113:19091'

/** Supply explicit read-only development API identity to an unpackaged Desktop Host.
 * @param environment - inherited desktop environment; explicit overrides win.
 * @param development - whether the Electron app is unpackaged.
 * @param mode - selected G1brain sign-in mode.
 * @returns development-only Host environment values, or no additions in packaged/OAuth mode.
 */
export function g1brainDevelopmentHostEnvironment(
  environment: NodeJS.ProcessEnv,
  development: boolean,
  mode: 'local-dev' | 'oauth',
): NodeJS.ProcessEnv {
  if (!development || mode !== 'local-dev') return {}
  return {
    G1BRAIN_BASE_URL: environment.G1BRAIN_BASE_URL?.trim() || DEFAULT_G1BRAIN_DEV_BASE_URL,
    G1BRAIN_LOCAL_USER_ID: environment.G1BRAIN_LOCAL_USER_ID?.trim() || 'developer',
    G1BRAIN_LOCAL_CLIENT_ID: environment.G1BRAIN_LOCAL_CLIENT_ID?.trim() || 'g1brain-web',
    G1BRAIN_ALLOW_LOCAL_DEV: '1',
    G1BRAIN_ALLOW_DEV_WRITES: environment.G1BRAIN_ALLOW_DEV_WRITES?.trim() || '1',
  }
}

export type G1brainLoginResult =
  | { readonly ok: true; readonly username: string }
  | { readonly ok: false; readonly reason: 'missing-config' | 'invalid-credentials' | 'unavailable' }

/** The renderer never receives the OAuth client secret, password ciphertext, or access token. */
export class G1brainAuth {
  private token: string | undefined
  private localAccount: string | undefined
  private expiresAt = 0

  constructor(
    private readonly environment: () => NodeJS.ProcessEnv,
    private readonly send: typeof fetch = fetch,
  ) {}

  /** @returns whether this process still has a usable G1brain access token. */
  get signedIn(): boolean {
    return this.localAccount !== undefined
      || (this.token !== undefined && (this.expiresAt === 0 || Date.now() < this.expiresAt))
  }

  /** @returns the explicit OAuth mode or the development-only local login mode. */
  get mode(): 'local-dev' | 'oauth' { return this.environment().G1BRAIN_AUTH_MODE === 'oauth' ? 'oauth' : 'local-dev' }

  /**
   * Exchange one username and password with G1brain OAuth; retain only the access token in memory.
   * @param username - G1brain account name.
   * @param password - G1brain password, never persisted by Desktop.
   * @returns a renderer-safe result without backend response details.
   */
  async login(username: string, password: string): Promise<G1brainLoginResult> {
    const account = username.trim()
    if (account === '' || password === '') return { ok: false, reason: 'invalid-credentials' }
    const env = this.environment()
    if (this.mode === 'local-dev') {
      this.localAccount = account
      return { ok: true, username: account }
    }
    const secret = env.G1BRAIN_CLIENT_SECRET?.trim()
    if (!secret) return { ok: false, reason: 'missing-config' }
    let baseUrl: URL
    try {
      baseUrl = new URL(env.G1BRAIN_BASE_URL ?? DEFAULT_G1BRAIN_DEV_BASE_URL)
      if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new Error('invalid G1brain address')
    } catch { return { ok: false, reason: 'missing-config' } }
    const tenantId = env.G1BRAIN_TENANT_ID?.trim() || '000000'
    const clientId = env.G1BRAIN_CLIENT_ID?.trim() || 'lhzstp'
    const publicKey = env.G1BRAIN_PUBLIC_KEY?.trim() || DEFAULT_PUBLIC_KEY
    let encrypted: string
    try { encrypted = sm2.doEncrypt(md5(password), publicKey, 0) }
    catch { return { ok: false, reason: 'missing-config' } }
    const form = new URLSearchParams({ tenantId, username: account, password: encrypted, grant_type: 'password', scope: 'all', type: 'account' })
    try {
      const response = await this.send(new URL('api/blade-auth/oauth/token', `${baseUrl.href.replace(/\/$/u, '')}/`), {
        method: 'POST', signal: AbortSignal.timeout(20_000),
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`, 'utf8').toString('base64')}`,
          'Tenant-Id': tenantId,
          'User-Type': 'app',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      })
      if (!response.ok) return { ok: false, reason: response.status === 400 || response.status === 401 ? 'invalid-credentials' : 'unavailable' }
      const value: unknown = await response.json()
      const payload = isRecord(value) && isRecord(value.data) ? value.data : value
      if (!isRecord(payload) || typeof payload.access_token !== 'string' || payload.access_token === '') return { ok: false, reason: 'unavailable' }
      this.token = payload.access_token
      this.expiresAt = typeof payload.expires_in === 'number' && payload.expires_in > 30
        ? Date.now() + (payload.expires_in - 30) * 1000 : 0
      return { ok: true, username: account }
    } catch { return { ok: false, reason: 'unavailable' } }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
