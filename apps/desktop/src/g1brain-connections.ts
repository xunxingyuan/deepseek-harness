/** Main-process connection preferences; URLs are persisted separately from credentials and Session targets. */
import { lstat, readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { G1brainConnections } from './welcome-api.ts'

/** Validate renderer or saved connection values without accepting credentials or redirect parameters.
 * @param value - untrusted JSON preferences.
 * @returns normalized HTTP(S) service roots.
 */
export function parseG1brainConnections(value: unknown): G1brainConnections {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !('baseUrl' in value) || !('tableBaseUrl' in value) || Object.keys(value).length !== 2) throw new Error('Invalid service settings')
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
  constructor(private readonly path: string) {}

  /** Read saved values without silently substituting defaults for damaged settings.
   * @returns saved preferences, or undefined before the user's first save.
   */
  async load(): Promise<G1brainConnections | undefined> {
    let info: Awaited<ReturnType<typeof lstat>>
    try { info = await lstat(this.path) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024) throw new Error('Invalid connection preference file')
    const record: unknown = JSON.parse(await readFile(this.path, 'utf8'))
    if (record === null || typeof record !== 'object' || !('version' in record) || record.version !== 1 || !('settings' in record)) {
      throw new Error('Unsupported connection preference file')
    }
    return parseG1brainConnections(record.settings)
  }

  /** Save only validated service URLs; a failed write leaves the previous file intact.
   * @param settings - validated preferences from the main-process input parser.
   * @returns after the complete next preference file is committed.
   */
  async save(settings: G1brainConnections): Promise<void> {
    await writeFileAtomic(this.path, JSON.stringify({ version: 1, settings }) + '\n', { mode: 0o600, dirMode: 0o700 })
  }
}
