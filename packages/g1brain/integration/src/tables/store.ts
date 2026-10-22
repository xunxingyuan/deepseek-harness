/** Private immutable collection mappings and upload-intent journals; uncertain writes are never retried blindly. */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isObject, type TableCollection } from './client.ts'

/** Persisted receipt for one source-derived upload. */
export interface ImportReceipt {
  readonly key: string
  readonly kind: 'table' | 'document'
  readonly path: string
  readonly sourceHash: string
  readonly uploadName: string
  readonly collectionId: string
  readonly sheets: readonly string[]
  readonly jobIds: readonly string[]
  readonly result?: unknown
}

/** Hash local import identities without exposing file contents in filenames.
 * @param value - canonical source metadata or bytes.
 * @returns lowercase SHA-256.
 */
export function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

/** One domain's journal, also shared by resumed Sessions targeting the same service and domain. */
export class TableStore {
  /** Hash of the exact service, tenant, ontology, and domain source identity. */
  readonly scopeKey: string
  private readonly directory: string

  constructor(root: string, readonly source: string) {
    this.scopeKey = digest(source)
    this.directory = join(root, this.scopeKey)
  }

  private async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const info = await lstat(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error('表格导入记录目录不是私有目录')
  }

  private path(key: string): string {
    if (!/^(?:collection|[a-f0-9]{64}\.(?:intent|receipt))$/u.test(key)) throw new Error('表格导入记录名称无效')
    return join(this.directory, `${key}.json`)
  }

  private async load(key: string): Promise<unknown> {
    const path = this.path(key)
    let info: Awaited<ReturnType<typeof lstat>>
    try { info = await lstat(path) }
    catch (error) { if (isObject(error) && error.code === 'ENOENT') return undefined; throw error }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('表格导入记录不是普通文件')
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!isObject(value) || value.version !== 1 || value.source !== this.source) throw new Error('表格导入记录的版本或绑定范围不匹配')
    return value.value
  }

  private async exclusive(key: string, value: unknown): Promise<boolean> {
    await this.prepare()
    try {
      await writeFile(this.path(key), JSON.stringify({ version: 1, source: this.source, value }), { flag: 'wx', mode: 0o600 })
      return true
    } catch (error) { if (isObject(error) && error.code === 'EEXIST') return false; throw error }
  }

  /** Read the immutable table collection mapped to this domain.
   * @returns saved collection, or undefined before first table upload.
   */
  async collection(): Promise<TableCollection | undefined> {
    const value = await this.load('collection')
    if (value === undefined) return undefined
    if (!isObject(value) || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.description !== 'string') throw new Error('表格集合绑定记录无效')
    return { id: value.id, name: value.name, description: value.description }
  }

  /** Save a resolved collection; another process may only have saved the same ID.
   * @param collection - server-confirmed collection.
   * @returns after the immutable mapping is available.
   */
  async bind(collection: TableCollection): Promise<void> {
    if (await this.exclusive('collection', collection)) return
    if ((await this.collection())?.id !== collection.id) throw new Error('当前领域已经关联其他表格集合，不能覆盖绑定')
  }

  /** Read an upload receipt, rejecting malformed records instead of repeating a possible write.
   * @param key - source-and-route fingerprint.
   * @returns accepted upload receipt when present.
   */
  async receipt(key: string): Promise<ImportReceipt | undefined> {
    const value = await this.load(`${key}.receipt`)
    if (value === undefined) return undefined
    if (!isObject(value) || value.key !== key || (value.kind !== 'table' && value.kind !== 'document')
      || typeof value.path !== 'string' || typeof value.sourceHash !== 'string' || typeof value.uploadName !== 'string'
      || typeof value.collectionId !== 'string' || !Array.isArray(value.sheets) || value.sheets.some(item => typeof item !== 'string')
      || !Array.isArray(value.jobIds) || value.jobIds.some(item => typeof item !== 'string')) throw new Error('表格上传回执无效，请先核对服务端数据')
    const strings = (items: readonly unknown[]) => items.map((item) => {
      if (typeof item !== 'string') throw new Error('上传回执的 ID 或工作表列表无效')
      return item
    })
    return { key, kind: value.kind, path: value.path, sourceHash: value.sourceHash, uploadName: value.uploadName,
      collectionId: value.collectionId, sheets: strings(value.sheets), jobIds: strings(value.jobIds),
      ...('result' in value ? { result: value.result } : {}) }
  }

  /** Reserve an upload before any network write; a prior unresolved intent blocks duplicates.
   * @param key - source-and-route fingerprint.
   * @returns true only to the exclusive uploader.
   */
  async reserve(key: string): Promise<boolean> {
    return this.exclusive(`${key}.intent`, { key })
  }

  /** Release an intent only after a definite HTTP rejection with no accepted job.
   * @param key - reservation owned by this upload operation.
   * @returns after removing only this journal's intent file.
   */
  async reject(key: string): Promise<void> {
    await this.load(`${key}.intent`)
    await unlink(this.path(`${key}.intent`))
  }

  /** Persist an accepted result without replacing earlier receipts.
   * @param receipt - network-confirmed upload result.
   * @returns after the receipt is durable.
   */
  async accepted(receipt: ImportReceipt): Promise<void> {
    if (!await this.exclusive(`${receipt.key}.receipt`, receipt)) throw new Error('上传结果已经记录，不能重复覆盖')
  }

  /** List only receipts belonging to this exact service/domain mapping.
   * @returns validated upload receipts.
   */
  async receipts(): Promise<ImportReceipt[]> {
    let files: string[]
    try { files = await readdir(this.directory) }
    catch (error) { if (isObject(error) && error.code === 'ENOENT') return []; throw error }
    const results: ImportReceipt[] = []
    for (const file of files.filter(file => /^[a-f0-9]{64}\.receipt\.json$/u.test(file))) {
      const value = await this.receipt(file.slice(0, 64))
      if (value) results.push(value)
    }
    return results
  }
}
