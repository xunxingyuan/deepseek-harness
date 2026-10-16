import { realpath, readdir, readFile, stat } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ScopeFile } from '../types.ts'
import { ScopeError } from '../errors.ts'
import { extractMaterial } from './material.ts'

const DEFAULT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.json',
  '.csv',
  '.tsv',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
])

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function cleanRelativePath(value: string): string {
  if (!value || value === '.') return ''
  if (value.includes('\0')) throw new ScopeError('路径包含非法字符', value)
  if (isAbsolute(value)) throw new ScopeError('工具参数必须是相对路径', value)
  return value
}

/** Material directory traversal limits for one bound Session. */
export interface WorkspaceScopeOptions {
  allowedExtensions?: Set<string>
  maxFileBytes?: number
  maxFiles?: number
}

class WorkspaceScopeImpl {
  readonly rootPath: string
  private readonly options: Required<WorkspaceScopeOptions>

  private constructor(rootPath: string, options: WorkspaceScopeOptions = {}) {
    this.rootPath = rootPath
    this.options = {
      allowedExtensions: options.allowedExtensions ?? DEFAULT_EXTENSIONS,
      maxFileBytes: options.maxFileBytes ?? 50 * 1024 * 1024,
      maxFiles: options.maxFiles ?? 2_000,
    }
  }

  static async open(rootPath: string, options: WorkspaceScopeOptions = {}): Promise<WorkspaceScopeImpl> {
    if (!rootPath || rootPath.includes('\0')) throw new ScopeError('资料目录不能为空', rootPath)
    const canonical = await realpath(rootPath).catch(() => {
      throw new ScopeError('资料目录不存在或不可访问', rootPath)
    })
    const info = await stat(canonical)
    if (!info.isDirectory()) throw new ScopeError('资料路径不是目录', rootPath)
    return new WorkspaceScopeImpl(canonical, options)
  }

  resolveRelative(relativePath: string): string {
    const cleaned = cleanRelativePath(relativePath)
    const candidate = resolve(this.rootPath, cleaned)
    if (!inside(this.rootPath, candidate)) throw new ScopeError('路径超出已选择的资料目录', relativePath)
    return candidate
  }

  async resolveExisting(relativePath: string): Promise<string> {
    const candidate = this.resolveRelative(relativePath)
    const canonical = await realpath(candidate).catch(() => {
      throw new ScopeError('文件不存在或不可访问', relativePath)
    })
    if (!inside(this.rootPath, canonical)) throw new ScopeError('符号链接目标超出资料目录', relativePath)
    return canonical
  }

  async read(relativePath: string, maxBytes = 2 * 1024 * 1024): Promise<string> {
    const file = await this.inspect(relativePath)
    const bytes = await readFile(file.absolutePath)
    if (bytes.length > this.options.maxFileBytes) throw new ScopeError('文件超过大小上限', relativePath)
    try {
      return await extractMaterial(bytes, file.extension, maxBytes, this.options.maxFileBytes)
    } catch (error) {
      throw new ScopeError(`${relativePath} 正文提取失败：${error instanceof Error ? error.message : String(error)}`, relativePath)
    }
  }

  async prepareUploads(paths: string[]): Promise<Array<{ path: string; uploadName: string; contents: string }>> {
    const files = []
    const names = new Set<string>()
    let total = 0
    for (const path of paths) {
      const contents = await this.read(path, this.options.maxFileBytes)
      const canonical = relative(this.rootPath, await this.resolveExisting(path)).replaceAll('\\', '/')
      const uploadName = /\.(?:md|markdown)$/i.test(canonical) ? canonical : `${canonical}.md`
      if (names.has(uploadName)) throw new ScopeError(`上传名称重复：${uploadName}`, path)
      names.add(uploadName)
      total += Buffer.byteLength(contents, 'utf8')
      if (total > this.options.maxFileBytes) throw new ScopeError('本批次正文总量超过文件大小上限；请分批上传', path)
      files.push({ path, uploadName, contents })
    }
    return files
  }

  async listFiles(): Promise<ScopeFile[]> {
    const result: ScopeFile[] = []
    await this.walk(this.rootPath, result)
    result.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    return result
  }

  async inspect(relativePath: string): Promise<ScopeFile> {
    const absolutePath = await this.resolveExisting(relativePath)
    const info = await stat(absolutePath)
    if (!info.isFile()) throw new ScopeError('目标不是文件', relativePath)
    if (info.size > this.options.maxFileBytes || !this.options.allowedExtensions.has(extname(absolutePath).toLowerCase())) throw new ScopeError('文件类型或大小不在允许范围内', relativePath)
    return {
      relativePath: relativePath.replaceAll('\\', '/'),
      absolutePath,
      size: info.size,
      extension: extname(absolutePath).toLowerCase(),
    }
  }

  private async walk(directory: string, result: ScopeFile[]): Promise<void> {
    if (result.length >= this.options.maxFiles) return
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (result.length >= this.options.maxFiles) return
      if (entry.name.startsWith('.')) continue
      const absolutePath = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        await this.walk(absolutePath, result)
        continue
      }
      if (!entry.isFile()) continue
      const extension = extname(entry.name).toLowerCase()
      if (!this.options.allowedExtensions.has(extension)) continue
      const info = await stat(absolutePath)
      if (info.size > this.options.maxFileBytes) continue
      result.push({
        relativePath: relative(this.rootPath, absolutePath).replaceAll('\\', '/'),
        absolutePath,
        size: info.size,
        extension,
      })
    }
  }
}

/** Restrained local directory view used by G1brain file tools. */
export type WorkspaceScope = WorkspaceScopeImpl

/** Validate and open a local materials directory.
 * @param rootPath - selected absolute directory.
 * @param options - file extensions and size caps.
 * @returns a canonical, path-confined directory reader.
 */
export function openWorkspaceScope(rootPath: string, options: WorkspaceScopeOptions = {}): Promise<WorkspaceScope> {
  return WorkspaceScopeImpl.open(rootPath, options)
}
