/** Resolve project-scoped picture categories through the existing resource-management API. */
import { createHash } from 'node:crypto'
import { G1BrainError } from '../errors.ts'
import type { PreparedTask, ResourceImageProject } from '../types.ts'

/** Determine picture ownership from the bound ontology, or the explicit document library for unbound callers.
 * @param task - trusted Session binding; partial ontology targets cannot fall back to a document library.
 * @param library - document-library API name.
 * @param displayName - current domain display name when available.
 * @returns a business identity independent of the Session and local source folder.
 */
export function resourceImageProject(task: PreparedTask | undefined, library: string, displayName?: string): ResourceImageProject {
  const collectionName = task?.ontologyCollectionName ?? task?.createOntologyCollectionName
  const domainName = task?.domainName ?? task?.createDomainName
  if (collectionName || domainName) {
    if (!collectionName || !domainName) throw new Error('图片项目缺少本体集合或领域绑定，不能回退到文档库分类')
    return { kind: 'ontology', collectionName, domainName, displayName: displayName ?? task?.createDomainDisplayName ?? domainName }
  }
  return { kind: 'document-library', collectionName: library, displayName: library }
}

interface CategoryOptions {
  readonly baseUrl: string
  readonly tenantId: string
  readonly parentId: string
  readonly namespaceName: string
  readonly request: (path: string, init?: RequestInit) => Promise<unknown>
}
interface Category { readonly id: string; readonly name: string }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  if (typeof value === 'string' && /^[1-9][0-9]*$/u.test(value)) return value
  throw new Error('图片分类 ID 无效，已停止上传')
}

/** Server-backed identity markers survive restarts; concurrent creates in this client are serialized per category. */
export class ResourceCategories {
  private readonly pending = new Set<string>()
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly parentId: string
  private readonly namespaceName: string

  constructor(private readonly options: CategoryOptions) {
    this.parentId = id(options.parentId)
    this.namespaceName = options.namespaceName.trim()
    if (!this.namespaceName || this.namespaceName.length > 120 || /[\u0000-\u001f\u007f]/u.test(this.namespaceName)) {
      throw new Error('图片一级分类名称须为不含控制字符的 1～120 字符名称')
    }
  }

  private serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const operation = previous.catch((_previousFailed: unknown) => undefined).then(run).finally(() => {
      if (this.queues.get(key) === operation) this.queues.delete(key)
    })
    this.queues.set(key, operation)
    return operation
  }

  private async children(parentId: string, signal?: AbortSignal): Promise<Category[]> {
    signal?.throwIfAborted()
    const query = new URLSearchParams({ id: parentId, categoryType: 'picture' })
    const tree = await this.options.request(`/resManagementAPI/category/list?${query}`, { signal: signal ?? null })
    if (!record(tree) || id(tree.id) !== parentId || (tree.categoryType !== undefined && tree.categoryType !== 'picture')) {
      throw new Error('图片分类响应与目标父分类不匹配，已停止上传')
    }
    const children = tree.childList ?? []
    if (!Array.isArray(children)) throw new Error('图片子分类列表无效，已停止上传')
    const ids = new Set<string>([parentId])
    return children.map((child: unknown) => {
      if (!record(child) || typeof child.categoryName !== 'string' || !child.categoryName.trim()
        || (child.parentId !== undefined && id(child.parentId) !== parentId)
        || (child.categoryType !== undefined && child.categoryType !== 'picture')) throw new Error('图片子分类记录无效，已停止上传')
      const categoryId = id(child.id)
      if (ids.has(categoryId)) throw new Error('图片分类 ID 重复，已停止上传')
      ids.add(categoryId)
      return { id: categoryId, name: child.categoryName }
    })
  }

  private async ensure(parentId: string, name: string, key: string, match: (row: Category) => boolean,
    userId: string, signal?: AbortSignal): Promise<string> {
    const find = async (): Promise<Category | undefined> => {
      const matches = (await this.children(parentId, signal)).filter(match)
      if (matches.length > 1) throw new Error('图片项目分类存在重复记录，请先核对资源管理；不会任意选取或写入根分类')
      return matches[0]
    }
    const existing = await find()
    if (existing) { this.pending.delete(key); return existing.id }
    if (this.pending.has(key)) throw new Error('图片分类上次创建结果不确定，请先核对资源管理；不会自动重复创建')
    signal?.throwIfAborted()
    this.pending.add(key)
    let definitiveRejection = false
    try {
      const query = new URLSearchParams({ name, parentId, userId, categoryType: 'picture' })
      await this.options.request(`/resManagementAPI/category/add?${query}`, { method: 'POST', signal: signal ?? null })
    } catch (error) {
      const status = error instanceof G1BrainError ? error.status : undefined
      definitiveRejection = status !== undefined && status >= 400 && status < 500 && status !== 408
      if (definitiveRejection) this.pending.delete(key)
      if (signal?.aborted || (definitiveRejection && status !== 400 && status !== 409)) throw error
    }
    const confirmed = await find()
    if (!confirmed) throw new Error(definitiveRejection ? '图片分类创建失败，请检查分类名称和创建权限'
      : '图片分类创建结果不确定，请先核对资源管理；不会自动重复创建')
    this.pending.delete(key)
    return confirmed.id
  }

  /** Resolve the dedicated client category and its exact project child; never return either ancestor as an upload target.
   * @param project - ontology or document-library identity; labels are excluded from its fingerprint.
   * @param userId - current authenticated uploader, never a default administrator.
   * @param signal - caller cancellation; a cancelled queued call performs no write.
   * @returns a server-confirmed project category ID, or rejects without falling back to the root.
   */
  project(project: ResourceImageProject, userId: string, signal?: AbortSignal): Promise<string> {
    const source = [new URL(this.options.baseUrl).href.replace(/\/$/u, ''), this.options.tenantId, this.parentId,
      this.namespaceName, project.kind, project.collectionName, project.kind === 'ontology' ? project.domainName : null]
    const marker = `[g1brain_${createHash('sha256').update(JSON.stringify(source)).digest('hex')}]`
    const label = Array.from(project.displayName.trim().replace(/[\u0000-\u001f\u007f]/gu, ' ')).slice(0, 80).join('')
    if (!label) return Promise.reject(new Error('图片项目显示名称不能为空'))
    const rootKey = JSON.stringify([this.parentId, this.namespaceName])
    return this.serial(marker, async () => {
      const parent = await this.serial(rootKey, () => this.ensure(this.parentId, this.namespaceName, rootKey,
        row => row.name === this.namespaceName, userId, signal))
      const category = await this.ensure(parent, `${label} ${marker}`, marker, row => row.name.endsWith(` ${marker}`), userId, signal)
      if (category === this.parentId || category === parent) throw new Error('图片项目分类不能使用图片根分类或一级分类')
      return category
    })
  }
}
