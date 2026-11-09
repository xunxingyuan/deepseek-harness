/** Reconcile content-addressed static pictures before publishing their URLs in Markdown. */
import { createHash } from 'node:crypto'
import type { MaterialImage } from '../bridge/images.ts'
import { G1BrainError } from '../errors.ts'

/** Authenticated resource requests and anonymous same-origin image verification. */
interface ResourceImageOptions {
  readonly baseUrl: string
  readonly categoryId: string
  readonly userId: string
  readonly request: (path: string, init?: RequestInit) => Promise<unknown>
  readonly fetchPublic: typeof fetch
  readonly signal: AbortSignal
  readonly intents: Set<string>
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function pictureRecords(options: ResourceImageOptions, filename: string): Promise<Record<string, unknown>[]> {
  const query = new URLSearchParams({ id: options.categoryId, current: '1', size: '100', keyword: filename })
  const value = await options.request(`/resManagementAPI/res/searchByKeyword?${query}`, { signal: options.signal })
  if (!record(value) || !Array.isArray(value.records)) throw new Error('静态图片列表响应无效，已停止上传')
  return value.records.filter(record).filter(item => item.name === filename)
}

async function publicPicture(options: ResourceImageOptions, row: Record<string, unknown>, image: MaterialImage): Promise<string> {
  if (typeof row.path !== 'string' || !row.path.startsWith('/') || row.path.startsWith('//') || /[\r\n\0]/u.test(row.path)) {
    throw new Error('静态图片未返回可用的同源永久路径，不能写入 Markdown')
  }
  const base = new URL(options.baseUrl)
  const url = new URL(row.path, base.origin)
  if (url.origin !== base.origin || url.username || url.password || url.hash || url.search) throw new Error('静态图片路径不能包含跨域、凭据或临时令牌')
  const response = await options.fetchPublic(url, { headers: { Accept: 'image/*' }, signal: options.signal, redirect: 'error' })
  if (!response.ok || !response.body) throw new Error('图片已在资源管理中，但无法匿名读取永久链接；未提交缺图 Markdown，请检查静态文件访问配置')
  const reader = response.body.getReader()
  const hash = createHash('sha256')
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > image.bytes.length) throw new Error('同名静态图片内容与源图片不一致')
      hash.update(chunk.value)
    }
  } finally { await reader.cancel() }
  if (size !== image.bytes.length || hash.digest('hex') !== image.key) throw new Error('静态图片回读校验失败，未提交 Markdown')
  return url.href
}

/** Reuse only exact, byte-verified pictures; uncertain upload outcomes never trigger an automatic second POST.
 * @param image - preflighted raster image.
 * @param options - same-origin authenticated transport and operation cancellation.
 * @returns a verified, anonymous static URL, without credentials in the URL or Markdown.
 */
export async function uploadResourceImage(image: MaterialImage, options: ResourceImageOptions): Promise<string> {
  const filename = `g1brain-${image.key}.${image.extension}`
  let records = await pictureRecords(options, filename)
  if (records.length > 1) throw new Error('静态图片存在同名重复记录，请先核对资源管理')
  if (records.length === 0) {
    const key = JSON.stringify([options.userId, options.categoryId, image.key])
    if (options.intents.has(key)) throw new Error('此图片上次上传结果不确定，请先核对资源管理；不会自动重复上传')
    options.intents.add(key)
    const form = new FormData()
    form.append('files', new File([Uint8Array.from(image.bytes)], filename, { type: image.contentType }))
    form.append('id', options.categoryId)
    form.append('fileType', 'picture')
    try {
      await options.request(`/resManagementAPI/res/upload?${new URLSearchParams({ userId: options.userId })}`, {
        method: 'POST', body: form, signal: options.signal,
      })
    } catch (error) {
      if (error instanceof G1BrainError && error.status !== undefined && error.status >= 400 && error.status < 500) {
        options.intents.delete(key)
      }
      throw error
    }
    records = await pictureRecords(options, filename)
  }
  const row = records[0]
  if (records.length !== 1 || !row) throw new Error('图片上传已提交，但无法唯一回读记录，请核对资源管理，不要直接重传')
  return publicPicture(options, row, image)
}
