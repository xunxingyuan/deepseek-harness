/** G1brain password authentication owned by the Electron main process. */

import { Buffer } from 'node:buffer'
import md5 from 'js-md5'
import { sm2 } from 'sm-crypto'

const DEFAULT_PUBLIC_KEY = '0445d8d7059501ed8f96f3b8baa4215bd215ef1e67a923a73da60939984384d979c3025ba7ee4340e1bec0817a19636cadea7c34e80155ee55476fdeb62465199a'

/** Existing G1brain API used by local development and explicitly marked unsigned test packages. */
export const DEFAULT_G1BRAIN_DEV_BASE_URL = 'http://192.168.100.113:19091'

/** Table-data service used by the explicitly enabled G1brain development connection. */
export const DEFAULT_G1BRAIN_TABLE_DEV_BASE_URL = 'http://192.168.100.113:8090'

/** Supply the development API identity to a local-development or unsigned-test Desktop Host.
 * @param environment - inherited desktop environment; explicit overrides win.
 * @param development - whether the Electron app is unpackaged.
 * @param mode - selected G1brain sign-in mode.
 * @param manifest - application metadata; unsigned test packages explicitly enable the development connection.
 * @returns development Host environment values, or no additions for ordinary packaged/OAuth mode.
 */
export function g1brainDevelopmentHostEnvironment(
  environment: NodeJS.ProcessEnv,
  development: boolean,
  mode: 'local-dev' | 'oauth',
  manifest?: unknown,
): NodeJS.ProcessEnv {
  const testPackage = typeof manifest === 'object' && manifest !== null
    && 'g1brainDevelopmentConnection' in manifest && manifest.g1brainDevelopmentConnection === true
  if ((!development && !testPackage) || mode !== 'local-dev') return {}
  return {
    G1BRAIN_BASE_URL: environment.G1BRAIN_BASE_URL?.trim() || DEFAULT_G1BRAIN_DEV_BASE_URL,
    G1BRAIN_TABLE_BASE_URL: environment.G1BRAIN_TABLE_BASE_URL?.trim() || DEFAULT_G1BRAIN_TABLE_DEV_BASE_URL,
    G1BRAIN_LOCAL_USER_ID: environment.G1BRAIN_LOCAL_USER_ID?.trim() || 'developer',
    G1BRAIN_LOCAL_CLIENT_ID: environment.G1BRAIN_LOCAL_CLIENT_ID?.trim() || 'g1brain-web',
    G1BRAIN_ALLOW_LOCAL_DEV: '1',
    G1BRAIN_ALLOW_DEV_WRITES: environment.G1BRAIN_ALLOW_DEV_WRITES?.trim() || '1',
  }
}

export type G1brainLoginResult =
  | { readonly ok: true; readonly username: string }
  | { readonly ok: false; readonly reason: 'missing-config' | 'invalid-credentials' | 'unavailable' }

/** Access-only snapshot carried over private Desktop IPC; refresh tokens stay in the main process. */
export interface G1brainHostCredential {
  readonly accessToken: string
  readonly userId: string
  readonly revision: number
  readonly expiresAt?: number
}

/** Safe refresh outcome; no backend error body or refresh token crosses IPC. */
export type G1brainRefreshResult =
  | { readonly kind: 'updated'; readonly credential: G1brainHostCredential }
  | { readonly kind: 'expired' }
  | { readonly kind: 'unavailable' }

/** The renderer never receives the OAuth client secret, password ciphertext, or access token. */
export class G1brainAuth {
  private token: string | undefined
  private localAccount: string | undefined
  private expiresAt = 0
  private generation = 0
  private userId: string | undefined
  private expiryTimer: ReturnType<typeof setTimeout> | undefined
  private refreshToken: string | undefined
  private refreshInFlight: Promise<G1brainRefreshResult> | undefined
  private refreshAbort: AbortController | undefined
  private revision = 0
  private refreshFailures = 0

  constructor(
    private readonly environment: () => NodeJS.ProcessEnv,
    private readonly send: typeof fetch = fetch,
    private readonly onExpired?: () => void,
    private readonly onRefreshed?: () => void,
  ) {}

  /** @returns whether this process retains a login, including renewable credentials during a transient outage. */
  get signedIn(): boolean {
    return this.localAccount !== undefined
      || (this.token !== undefined && (this.refreshToken !== undefined || this.expiresAt === 0 || Date.now() < this.expiresAt))
  }

  /** @returns the explicit OAuth mode or the development-only local login mode. */
  get mode(): 'local-dev' | 'oauth' { return this.environment().G1BRAIN_AUTH_MODE === 'oauth' ? 'oauth' : 'local-dev' }

  /** @returns an opaque process-local generation used to discard expiry events from a previous Host. */
  get sessionGeneration(): number { return this.generation }

  /** Forget process-local credentials and invalidate any unfinished login response. */
  signOut(): void {
    this.generation++
    this.localAccount = undefined
    this.token = undefined
    this.expiresAt = 0
    this.userId = undefined
    this.refreshToken = undefined
    this.refreshInFlight = undefined
    this.refreshAbort?.abort()
    this.refreshAbort = undefined
    this.refreshFailures = 0
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
  }

  /** Forget rejected credentials once and notify the shell to return to Welcome.
   * @returns whether a real token was invalidated; repeated expiry notices do nothing.
   */
  expire(): boolean {
    if (this.token === undefined) return false
    this.signOut()
    this.onExpired?.()
    return true
  }

  /** Supply only the current process-local login to the private Host environment, never the renderer.
   * @returns a scoped token, user identity and deadline; signed-out/development states clear inherited OAuth credentials.
   */
  hostEnvironment(): NodeJS.ProcessEnv {
    const active = this.mode === 'oauth' && this.signedIn
    return { G1BRAIN_ACCESS_TOKEN: active ? this.token : undefined, G1BRAIN_REFRESH_TOKEN: undefined,
      G1BRAIN_USER_ID: active ? this.userId : undefined,
      G1BRAIN_ACCESS_TOKEN_EXPIRES_AT: active && this.expiresAt > 0 ? String(this.expiresAt) : undefined }
  }

  /** @returns the latest access-only credential, without exposing the refresh token. */
  credential(): G1brainHostCredential | undefined {
    if (!this.token || !this.userId) return undefined
    return { accessToken: this.token, userId: this.userId, revision: this.revision,
      ...(this.expiresAt > 0 ? { expiresAt: this.expiresAt } : {}) }
  }

  private armExpiry(generation: number, retryAfter?: number): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer)
    if (generation !== this.generation || this.token === undefined || (this.expiresAt === 0 && retryAfter === undefined)) return
    const remaining = this.expiresAt - Date.now()
    if (!this.refreshToken && remaining <= 0) { this.expire(); return }
    const delay = retryAfter ?? (this.refreshToken ? Math.max(1, remaining - Math.min(60000, remaining / 5)) : remaining)
    const due = Date.now() + delay
    this.expiryTimer = setTimeout(() => {
      if (generation !== this.generation) return
      if (Date.now() < due) { this.armExpiry(generation, due - Date.now()); return }
      if (this.refreshToken) void this.refresh().catch((_unexpected: unknown) => { console.warn('G1brain refresh could not complete') })
      else this.armExpiry(generation)
    }, Math.min(delay, 2147483647))
    this.expiryTimer.unref()
  }

  private acceptToken(payload: Record<string, unknown>, userId: string, refreshToken: string | undefined): void {
    this.token = String(payload.access_token)
    this.localAccount = undefined
    this.userId = userId
    this.refreshToken = refreshToken
    this.revision++
    this.refreshFailures = 0
    const lifetime = typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in) && payload.expires_in > 0
      ? Math.max(1, payload.expires_in) * 1000 : 0
    this.expiresAt = lifetime > 0 ? Date.now() + lifetime : 0
    this.armExpiry(this.generation)
  }

  /** Renew once for concurrent callers; a late rejection of an older access token uses the current snapshot.
   * @param rejectedAccessToken - access token used by a rejected Host request, or undefined for proactive refresh.
   * @returns updated access credentials, a definite rejection, or a transient failure that retains refresh capability.
   */
  refresh(rejectedAccessToken?: string): Promise<G1brainRefreshResult> {
    const current = this.credential()
    if (current && rejectedAccessToken !== undefined && rejectedAccessToken !== current.accessToken
      && (this.expiresAt === 0 || Date.now() < this.expiresAt)) return Promise.resolve({ kind: 'updated', credential: current })
    if (this.refreshInFlight) return this.refreshInFlight
    if (!this.token || !this.refreshToken || this.mode !== 'oauth') {
      this.expire()
      return Promise.resolve({ kind: 'expired' })
    }
    const generation = this.generation
    const token = this.refreshToken
    const operation = this.exchangeRefresh(generation, token).finally(() => {
      if (this.refreshInFlight === operation) this.refreshInFlight = undefined
    })
    this.refreshInFlight = operation
    return operation
  }

  private async exchangeRefresh(generation: number, refreshToken: string): Promise<G1brainRefreshResult> {
    const env = this.environment()
    const controller = new AbortController()
    this.refreshAbort = controller
    try {
      const clientId = env.G1BRAIN_CLIENT_ID?.trim() || 'lhzstp'
      const tenantId = env.G1BRAIN_TENANT_ID?.trim() || '000000'
      const base = new URL(env.G1BRAIN_BASE_URL ?? DEFAULT_G1BRAIN_DEV_BASE_URL)
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Invalid address')
      const response = await this.send(new URL('api/blade-auth/oauth/token', `${base.href.replace(/\/$/u, '')}/`), {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
        headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${env.G1BRAIN_CLIENT_SECRET?.trim() ?? ''}`, 'utf8').toString('base64')}`,
          'Tenant-Id': tenantId, 'User-Type': 'app', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ tenantId, refresh_token: refreshToken, grant_type: 'refresh_token', scope: 'all' }).toString(),
      })
      if (generation !== this.generation) return { kind: 'expired' }
      if ([400, 401, 403].includes(response.status)) { this.expire(); return { kind: 'expired' } }
      const value: unknown = await response.json()
      if (generation !== this.generation) return { kind: 'expired' }
      const code = isRecord(value) ? value.code : undefined
      const error = isRecord(value) ? value.error : undefined
      if ([400, 401, 403].some(status => code === status || code === String(status))
        || error === 'invalid_grant' || error === 'invalid_client' || error === 'unauthorized_client') {
        this.expire()
        return { kind: 'expired' }
      }
      const payload = isRecord(value) && isRecord(value.data) ? value.data : value
      if (!response.ok || !isRecord(payload) || typeof payload.access_token !== 'string' || !payload.access_token
        || (typeof code === 'number' && code >= 400)) throw new Error('Refresh unavailable')
      if (typeof payload.user_id === 'string' && payload.user_id !== this.userId) { this.expire(); return { kind: 'expired' } }
      const nextRefresh = typeof payload.refresh_token === 'string' && payload.refresh_token ? payload.refresh_token : refreshToken
      const userId = this.userId
      if (!userId) { this.expire(); return { kind: 'expired' } }
      this.acceptToken(payload, userId, nextRefresh)
      try { this.onRefreshed?.() } catch (_notificationFailure: unknown) { console.warn('G1brain credential notification failed') }
      const credential = this.credential()
      return credential ? { kind: 'updated', credential } : { kind: 'expired' }
    } catch (_unavailable: unknown) {
      if (generation !== this.generation) return { kind: 'expired' }
      this.refreshFailures++
      this.armExpiry(generation, Math.min(30000, 5000 * 2 ** Math.min(this.refreshFailures - 1, 3)))
      return { kind: 'unavailable' }
    } finally { if (this.refreshAbort === controller) this.refreshAbort = undefined }
  }

  /**
   * Exchange one username and password with G1brain OAuth; retain access and refresh tokens only in memory.
   * @param username - G1brain account name.
   * @param password - G1brain password, never persisted by Desktop.
   * @returns a renderer-safe result without backend response details.
   */
  async login(username: string, password: string): Promise<G1brainLoginResult> {
    this.signOut()
    const generation = this.generation
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
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
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
      if (isRecord(value) && (value.code === 401 || value.code === '401')) return { ok: false, reason: 'invalid-credentials' }
      const payload = isRecord(value) && isRecord(value.data) ? value.data : value
      if (!isRecord(payload) || typeof payload.access_token !== 'string' || payload.access_token === '') return { ok: false, reason: 'unavailable' }
      if (generation !== this.generation) return { ok: false, reason: 'unavailable' }
      let userId = typeof payload.user_id === 'string' ? payload.user_id
        : isRecord(payload.user) && typeof payload.user.id === 'string' ? payload.user.id : undefined
      if (!userId) {
        const info = await this.send(new URL('api/blade-user/info', `${baseUrl.href.replace(/\/$/u, '')}/`), {
          redirect: 'error', signal: AbortSignal.timeout(20_000),
          headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`, 'utf8').toString('base64')}`,
            'Blade-Auth': `bearer ${payload.access_token}`, 'Tenant-Id': tenantId },
        })
        if (!info.ok) return { ok: false, reason: 'unavailable' }
        const value: unknown = await info.json()
        if (isRecord(value) && (value.code === 401 || value.code === '401')) return { ok: false, reason: 'invalid-credentials' }
        const user = isRecord(value) && isRecord(value.data) ? value.data : undefined
        if (!user || typeof user.id !== 'string' || !user.id) return { ok: false, reason: 'unavailable' }
        userId = user.id
      }
      if (generation !== this.generation) return { ok: false, reason: 'unavailable' }
      this.acceptToken(payload, userId, typeof payload.refresh_token === 'string' && payload.refresh_token ? payload.refresh_token : undefined)
      return { ok: true, username: account }
    } catch { return { ok: false, reason: 'unavailable' } }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
