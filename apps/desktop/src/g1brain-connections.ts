/** Main-process connection preferences with OS-protected, write-only client credentials. */
import { Buffer } from 'node:buffer'
import { lstat, readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { G1brainConnectionInput } from './welcome-api.ts'

/** Public OAuth client identifier used by the home application; never a credential. */
export const DEFAULT_G1BRAIN_CLIENT_ID = 'lhzstp'

/** OS-backed encryption supplied by Electron after app readiness. */
export interface G1brainCredentialCipher {
  available(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

/** Validate service roots and write-only client credentials without accepting credential-bearing URLs.
 * @param value - untrusted JSON preferences.
 * @returns normalized HTTP(S) service roots and bounded client credentials.
 */
export function parseG1brainConnections(value: unknown): G1brainConnectionInput {
  if (!record(value) || Object.keys(value).length !== 4
    || !['baseUrl', 'tableBaseUrl', 'clientId', 'clientSecret'].every(key => key in value)
    || typeof value.clientId !== 'string' || !value.clientId.trim() || value.clientId.length > 256
    || /[:\r\n\u0000]/u.test(value.clientId)
    || typeof value.clientSecret !== 'string' || value.clientSecret.length > 4096
    || /[\r\n\u0000]/u.test(value.clientSecret)) throw new Error('Invalid service settings')
  return { ...addresses(value), clientId: value.clientId.trim(), clientSecret: value.clientSecret }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function addresses(value: Record<string, unknown>): { baseUrl: string; tableBaseUrl: string } {
  const address = (input: unknown, optional: boolean): string => {
    if (typeof input !== 'string' || input.length > 2048) throw new Error('Invalid service address')
    const text = input.trim()
    if (!text && optional) return ''
    const url = new URL(text)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
      throw new Error('Service addresses must use HTTP(S) without credentials, queries, or fragments')
    }
    return url.href.replace(/\/$/u, '')
  }
  return { baseUrl: address(value.baseUrl, false), tableBaseUrl: address(value.tableBaseUrl, true) }
}

/** Atomic, versioned preferences owned by Desktop, not writable through the workspace renderer. */
export class G1brainConnectionStore {
  constructor(private readonly path: string, private readonly cipher?: G1brainCredentialCipher) {}

  /** Read saved values without silently substituting defaults for damaged settings.
   * @returns saved preferences, or undefined before the user's first save.
   */
  async load(): Promise<G1brainConnectionInput | undefined> {
    let info: Awaited<ReturnType<typeof lstat>>
    try { info = await lstat(this.path) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024) throw new Error('Invalid connection preference file')
    const saved: unknown = JSON.parse(await readFile(this.path, 'utf8'))
    if (!record(saved) || !record(saved.settings)) throw new Error('Unsupported connection preference file')
    if (saved.version === 1 && Object.keys(saved.settings).length === 2) {
      return { ...addresses(saved.settings), clientId: DEFAULT_G1BRAIN_CLIENT_ID, clientSecret: '' }
    }
    if (saved.version !== 2 || Object.keys(saved.settings).length !== 3 || typeof saved.clientSecretEncrypted !== 'string') {
      throw new Error('Unsupported connection preference file')
    }
    let clientSecret = ''
    if (saved.clientSecretEncrypted) {
      const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
      if (!this.cipher?.available() || !base64.test(saved.clientSecretEncrypted)) {
        throw new Error('Secure credential storage is unavailable')
      }
      try { clientSecret = this.cipher.decrypt(Buffer.from(saved.clientSecretEncrypted, 'base64')) }
      catch { throw new Error('Could not decrypt connection credentials') }
      if (!clientSecret) throw new Error('Invalid encrypted connection credentials')
    }
    return parseG1brainConnections({ ...saved.settings, clientSecret })
  }

  /** Save OS-encrypted credentials; blank input preserves the previous secret.
   * @param settings - validated preferences from the main-process input parser.
   * @param fallbackSecret - main-process deployment default, never returned through IPC.
   * @returns after the complete next preference file is committed.
   */
  async save(settings: G1brainConnectionInput, fallbackSecret = ''): Promise<void> {
    const parsed = parseG1brainConnections(settings)
    const previous = await this.load()
    const clientSecret = parsed.clientSecret || previous?.clientSecret || fallbackSecret
    let encrypted = ''
    if (clientSecret) {
      if (!this.cipher?.available()) throw new Error('Secure credential storage is unavailable')
      try { encrypted = this.cipher.encrypt(clientSecret).toString('base64') }
      catch { throw new Error('Could not encrypt connection credentials') }
      if (!encrypted) throw new Error('Could not encrypt connection credentials')
    }
    const { baseUrl, tableBaseUrl, clientId } = parsed
    await writeFileAtomic(this.path, JSON.stringify({ version: 2, settings: { baseUrl, tableBaseUrl, clientId },
      clientSecretEncrypted: encrypted }) + '\n', { mode: 0o600, dirMode: 0o700 })
  }
}
