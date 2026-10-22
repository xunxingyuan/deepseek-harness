/** Preflighted material routing with domain-bound table collections and crash-safe duplicate suppression. */
import { Buffer } from 'node:buffer'
import { basename } from 'node:path'
import type { WorkspaceScope } from '../legacy/bridge/scope.ts'
import { extractMaterial } from '../legacy/bridge/material.ts'
import type { G1BrainClient } from '../legacy/g1brain/client.ts'
import type { G1brainSessionTarget } from '../types.ts'
import { TableApiError, TableClient, type TableCollection } from './client.ts'
import { planExcel, type SheetDecision } from './excel.ts'
import { digest, TableStore, type ImportReceipt } from './store.ts'

interface Artifact {
  readonly key: string
  readonly kind: 'table' | 'document'
  readonly path: string
  readonly sourceHash: string
  readonly uploadName: string
  readonly sheets: readonly string[]
  readonly bytes: Buffer
}

interface MaterialPlan {
  readonly decisions: ReadonlyArray<{ path: string; sourceHash: string; sheets: readonly SheetDecision[] }>
  readonly artifacts: readonly Artifact[]
}

/** Inputs owned by the bound G1brain Host Session. */
export interface MaterialRouterOptions {
  readonly scope: WorkspaceScope
  readonly target: G1brainSessionTarget
  readonly documents: G1BrainClient
  readonly tables: TableClient
  readonly store: TableStore
  readonly domainDisplayName: () => Promise<string>
}

/** Per-Session routing; persistent identities and import receipts are shared through TableStore. */
export class MaterialRouter {
  constructor(private readonly options: MaterialRouterOptions) {}

  private async plan(paths: readonly string[]): Promise<MaterialPlan> {
    if (!paths.length || paths.length > 20 || new Set(paths).size !== paths.length) throw new Error('每批须明确选择 1～20 个不重复的相对路径文件')
    const artifacts: Artifact[] = []
    const decisions: Array<MaterialPlan['decisions'][number]> = []
    const library = this.options.target.documentLibraryName ?? this.options.target.createDocumentLibraryName
    let total = 0
    for (const path of paths) {
      const { file, bytes } = await this.options.scope.readBytes(path)
      const sourceHash = digest(bytes)
      const excel = file.extension === '.xlsx' || file.extension === '.xls'
      const planned = excel ? planExcel(bytes, file.extension, 50 * 1024 * 1024) : undefined
      const sheets = planned?.sheets ?? []
      decisions.push({ path: file.relativePath, sourceHash, sheets })
      const tableBytes = planned?.tableBytes
      const documentText = planned ? planned.documentText : await extractMaterial(bytes, file.extension, 50 * 1024 * 1024, 50 * 1024 * 1024)
      if (tableBytes) {
        if (tableBytes.length > this.options.tables.options.maxUploadBytes) throw new Error(`${path} 的表格内容超过表格服务上传上限，请拆分文件`)
        const names = sheets.filter(sheet => sheet.route === 'table').map(sheet => sheet.name)
        artifacts.push({ key: digest(JSON.stringify(['excel-tables-v1', sourceHash, names])), kind: 'table', path: file.relativePath,
          sourceHash, uploadName: `${basename(file.relativePath)}.${sourceHash.slice(0, 8)}.tables.xlsx`, sheets: names, bytes: tableBytes })
        total += tableBytes.length
      }
      if (documentText !== undefined) {
        if (!library) throw new Error(`${path} 包含文档内容，但本次会话未选择向量文档库；请重新准备会话或仅选择规整表格文件`)
        const names = sheets.filter(sheet => sheet.route === 'document').map(sheet => sheet.name)
        const contents = Buffer.from(documentText, 'utf8')
        const uploadName = planned?.tableBytes ? `${file.relativePath}.notes.md`
          : /\.(?:md|markdown)$/iu.test(file.relativePath) ? file.relativePath : `${file.relativePath}.md`
        artifacts.push({ key: digest(JSON.stringify(['material-documents-v1', sourceHash, names, library])), kind: 'document',
          path: file.relativePath, sourceHash, uploadName, sheets: names, bytes: contents })
        total += contents.length
      }
      if (excel && !tableBytes && documentText === undefined) throw new Error(`${path} 没有可导入的表格或文档内容`)
      if (total > 50 * 1024 * 1024) throw new Error('本批次提取内容超过 50 MiB，请分批导入')
    }
    const names = artifacts.map(item => `${item.kind}:${item.uploadName}`)
    if (new Set(names).size !== names.length) throw new Error('本批次派生文件名称冲突，请分别导入')
    return { artifacts, decisions }
  }

  /** Inspect automatic routing without creating collections or uploading bytes.
   * @param paths - explicitly selected Workspace-relative materials.
   * @returns bounded per-sheet decisions, without workbook contents.
   */
  async inspect(paths: readonly string[]): Promise<unknown> {
    const plan = await this.plan(paths)
    return { files: plan.decisions.map(file => ({ ...file, sheets: file.sheets.map(sheet => ({ ...sheet,
      columnCount: sheet.columns.length, columns: sheet.columns.slice(0, 20) })) })),
    uploads: plan.artifacts.map(({ path, kind, uploadName, sheets, bytes }) => ({ path, kind, uploadName, sheets, bytes: bytes.length })) }
  }

  private async collection(create: boolean, signal?: AbortSignal): Promise<TableCollection | undefined> {
    const existing = await this.options.store.collection()
    if (!existing && !create) return undefined
    const collections = await this.options.tables.collections(signal)
    if (existing) {
      const actual = collections.find(item => item.id === existing.id)
      if (!actual) throw new Error('当前领域绑定的表格集合已经不存在，不能自动改绑其他集合')
      return actual
    }
    const marker = `G1brain domain binding:${this.options.store.scopeKey}`
    const label = (await this.options.domainDisplayName()).trim()
    if (!label) throw new Error('无法确定当前领域的显示名称')
    const shorten = (text: string, length: number) => Array.from(text).slice(0, length).join('')
    const plain = shorten(label, 80)
    const collision = collections.find(item => item.name.toLowerCase() === plain.toLowerCase())
    const name = collision && collision.description !== marker
      ? `${shorten(label, 69)} [${this.options.store.scopeKey.slice(0, 8)}]` : plain
    const same = collections.find(item => item.name.toLowerCase() === name.toLowerCase())
    let resolved: TableCollection
    if (same) {
      if (same.description !== marker) throw new Error('存在同名的其他表格集合，不能自动合并或覆盖')
      resolved = same
    } else {
      try { resolved = await this.options.tables.createCollection(name, marker, signal) }
      catch (error) {
        // A concurrent Host may have completed the same named creation; only its exact source marker permits adoption.
        const found = (await this.options.tables.collections(signal)).find(item => item.name === name && item.description === marker)
        if (!found) throw error
        resolved = found
      }
    }
    await this.options.store.bind(resolved)
    return resolved
  }

  /** Import a preflighted batch without retrying accepted or uncertain writes.
   * @param paths - selected source paths, never arbitrary remote URLs.
   * @param signal - caller cancellation.
   * @returns receipts that distinguish vector uploads from pending table jobs.
   */
  async upload(paths: readonly string[], signal?: AbortSignal): Promise<unknown> {
    const plan = await this.plan(paths)
    const table = plan.artifacts.some(item => item.kind === 'table') ? await this.collection(true, signal) : undefined
    const results: Array<Omit<ImportReceipt, 'result'> & { reused: boolean }> = []
    try {
      for (const artifact of plan.artifacts) {
        signal?.throwIfAborted()
        const previous = await this.options.store.receipt(artifact.key)
        if (previous) {
          if (artifact.kind === 'table' && previous.collectionId !== table?.id) throw new Error('历史表格上传回执与当前集合绑定不一致')
          const { result: _result, ...receipt } = previous
          results.push({ ...receipt, reused: true })
          continue
        }
        if (!await this.options.store.reserve(artifact.key)) throw new Error(`${artifact.path} 的上次上传仍在进行或结果不确定；请先核对服务端任务，不要直接重传`)
        let receipt: ImportReceipt
        try {
          if (artifact.kind === 'table') {
            if (!table) throw new Error('表格集合未准备完成')
            const jobIds = await this.options.tables.upload(table.id, artifact.uploadName, artifact.bytes, signal)
            receipt = { ...artifact, collectionId: table.id, jobIds }
          } else {
            const library = this.options.target.documentLibraryName ?? this.options.target.createDocumentLibraryName
            if (!library) throw new Error('未绑定向量文档库')
            const result = await this.options.documents.uploadMdFile(library, artifact.uploadName, artifact.bytes.toString('utf8'), signal)
            receipt = { ...artifact, collectionId: library, jobIds: [], result }
          }
        } catch (error) {
          if (error instanceof TableApiError && error.status !== undefined && error.status >= 400 && error.status < 500) {
            await this.options.store.reject(artifact.key)
          }
          throw error
        }
        // Source bytes belong only to the in-flight operation, never the persistent receipt.
        const saved: ImportReceipt = { key: receipt.key, kind: receipt.kind, path: receipt.path, sourceHash: receipt.sourceHash,
          uploadName: receipt.uploadName, collectionId: receipt.collectionId, sheets: receipt.sheets, jobIds: receipt.jobIds,
          ...('result' in receipt ? { result: receipt.result } : {}) }
        await this.options.store.accepted(saved)
        const { result: _result, ...summary } = saved
        results.push({ ...summary, reused: false })
      }
    } catch (error) {
      throw new Error(`本批次未全部完成：${error instanceof Error ? error.message : String(error)}。已接受的结果：${JSON.stringify(results)}`, { cause: error })
    }
    return { status: 'accepted', tableCollection: table ?? null, results,
      tableUploads: results.filter(item => item.kind === 'table').length, documentUploads: results.filter(item => item.kind === 'document').length,
      note: '表格须通过导入任务状态确认 completed；仅文档分支需要执行 G1brain MD/CHUNK 任务。accepted 不表示已完成入库或检索就绪。' }
  }

  /** Show the mapped collection without creating one as a side effect of a read.
   * @param signal - caller cancellation.
   * @returns current domain and optional table-collection identity.
   */
  async context(signal?: AbortSignal): Promise<unknown> {
    return { domainName: this.options.target.domainName ?? this.options.target.createDomainName,
      tableCollection: await this.collection(false, signal) ?? null }
  }

  /** Query only the mapped collection through the read-only MCP endpoint.
   * @param name - fixed read capability.
   * @param args - tool-specific arguments without an externally supplied collection scope.
   * @param signal - caller cancellation.
   * @returns the service's bounded structured result.
   */
  async read(name: Parameters<TableClient['read']>[1], args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const collection = await this.collection(false, signal)
    if (!collection) return { tables: [], note: '当前领域尚未导入表格，不会改查全部集合。' }
    return this.options.tables.read(collection.id, name, args, signal)
  }

  /** Read status only for this domain's persisted import jobs.
   * @param signal - caller cancellation.
   * @returns known jobs and explicit unknown IDs outside the service's recent-job window.
   */
  async imports(signal?: AbortSignal): Promise<unknown> {
    const collection = await this.collection(false, signal)
    if (!collection) return { jobs: [], missingJobIds: [] }
    const receipts = (await this.options.store.receipts()).filter(item => item.kind === 'table' && item.collectionId === collection.id)
    const ids = [...new Set(receipts.flatMap(item => item.jobIds))]
    if (!ids.length) return { jobs: [], missingJobIds: [] }
    const jobs = await this.options.tables.jobs(ids, collection.id, signal)
    return { jobs, missingJobIds: ids.filter(id => !jobs.some(job => job.id === id)),
      note: '服务只返回最近 100 个任务；未找到的任务结果未知，不能据此宣称成功或自动重传。' }
  }

  private async ownedJob(jobId: string, signal?: AbortSignal) {
    const collection = await this.collection(false, signal)
    if (!collection) throw new Error('当前领域还没有表格导入任务')
    const owned = (await this.options.store.receipts()).some(receipt => receipt.kind === 'table'
      && receipt.collectionId === collection.id && receipt.jobIds.includes(jobId))
    if (!owned) throw new Error('任务 ID 不属于当前领域的上传回执')
    const job = (await this.options.tables.jobs([jobId], collection.id, signal))[0]
    if (!job) throw new Error('任务已不在服务最近列表中，请先核对导入结果')
    return job
  }

  /** Preview only a job created through this domain's persisted upload receipt.
   * @param jobId - owned job ID.
   * @param sheet - worksheet name.
   * @param headerRow - optional 1-based row.
   * @param signal - caller cancellation.
   * @returns server-side missing-header details.
   */
  async headerPreview(jobId: string, sheet: string, headerRow?: number, signal?: AbortSignal): Promise<unknown> {
    await this.ownedJob(jobId, signal)
    return this.options.tables.headerPreview(jobId, sheet, headerRow, signal)
  }

  /** Resume a blocked import only by filling explicit missing headers; never discard columns.
   * @param jobId - owned blocked job ID.
   * @param sheet - worksheet from the preview.
   * @param headerRow - 1-based header row.
   * @param headers - missing-column names.
   * @param signal - caller cancellation.
   * @returns accepted resume result, whose completion still needs polling.
   */
  async fillHeaders(jobId: string, sheet: string, headerRow: number, headers: Record<string, string>,
    signal?: AbortSignal): Promise<unknown> {
    const job = await this.ownedJob(jobId, signal)
    if (job.status !== 'needs_input' && job.status !== 'partial') throw new Error('此任务当前不需要补齐表头')
    return this.options.tables.fillHeaders(jobId, sheet, headerRow, headers, signal)
  }
}
