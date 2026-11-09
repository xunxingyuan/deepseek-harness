/** Bounded raster-image attachments and Markdown references, without remote fetching or filesystem access. */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { fromMarkdown } from 'mdast-util-from-markdown'

/** A content-addressed image extracted from one authorized source. */
export interface MaterialImage {
  readonly key: string
  readonly placeholder: string
  readonly extension: string
  readonly contentType: string
  readonly bytes: Buffer
}

/** Preflighted Markdown and its referenced local or embedded image bytes. */
export interface MaterialDocument {
  readonly markdown: string
  readonly images: readonly MaterialImage[]
}

/** Recognize browser-displayable raster bytes rather than trusting a supplied file suffix.
 * @param bytes - complete image content within the caller's byte limit.
 * @returns a deterministic image identity; unsupported formats throw instead of disappearing.
 */
export function materialImage(bytes: Buffer): MaterialImage {
  let extension: string
  let contentType: string
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) { extension = 'png'; contentType = 'image/png' }
  else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) { extension = 'jpg'; contentType = 'image/jpeg' }
  else if (/^GIF8[79]a$/u.test(bytes.subarray(0, 6).toString('ascii'))) { extension = 'gif'; contentType = 'image/gif' }
  else if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') { extension = 'webp'; contentType = 'image/webp' }
  else if (bytes.subarray(0, 2).toString('ascii') === 'BM') { extension = 'bmp'; contentType = 'image/bmp' }
  else throw new Error('图片格式不受支持或内容无效；请转换为 PNG、JPEG、GIF、WebP 或 BMP，不能静默丢弃图片')
  const key = createHash('sha256').update(bytes).digest('hex')
  return { key, placeholder: `g1brain-image:${key}`, extension, contentType, bytes }
}

/** Enforce the complete derived Markdown-and-images budget.
 * @param document - extracted content, with identical images counted once.
 * @param maxBytes - complete output byte cap.
 * @returns the same document after checking its complete retained payload.
 */
export function checkedDocument(document: MaterialDocument, maxBytes: number): MaterialDocument {
  const size = Buffer.byteLength(document.markdown, 'utf8') + document.images.reduce((total, image) => total + image.bytes.length, 0)
  if (size > maxBytes) throw new Error(`正文及图片总量超过上限（${maxBytes} bytes）；请拆分材料后重试`)
  return document
}

function altText(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]').replace(/[\r\n]/gu, ' ')
}

/** Resolve only Markdown image destinations; code blocks and ordinary links are never treated as files.
 * @param source - Markdown source text.
 * @param load - caller-owned confined loader for relative image references.
 * @param maxBytes - complete retained text and images limit.
 * @param knownImages - embedded image digests whose bytes the caller already extracted.
 * @returns Markdown with opaque image placeholders and deduplicated image bytes.
 */
export async function markdownImages(
  source: string, load: (reference: string) => Promise<Buffer>, maxBytes: number, knownImages: ReadonlySet<string> = new Set(),
): Promise<MaterialDocument> {
  const tree = fromMarkdown(source)
  const definitions = new Map<string, { url: string; title?: string | null | undefined }>()
  const images = new Map<string, MaterialImage>()
  const changes: Array<{ start: number; end: number; text: string }> = []
  const visitDefinitions = (node: typeof tree | (typeof tree.children)[number]): void => {
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node)
    if ('children' in node) for (const child of node.children) visitDefinitions(child)
  }
  visitDefinitions(tree)
  const walk = async (node: typeof tree | (typeof tree.children)[number]): Promise<void> => {
    if (node.type === 'html' && /<img\b/iu.test(node.value)) throw new Error('Markdown 包含 HTML 图片标签，请先转换为标准 ![说明](相对路径) 图片语法')
    if (node.type === 'image' || node.type === 'imageReference') {
      const definition = node.type === 'image' ? node : definitions.get(node.identifier)
      if (!definition) throw new Error('Markdown 图片引用缺少对应定义')
      const reference = definition.url
      if (/^https?:\/\//iu.test(reference)) return
      if (reference.startsWith('g1brain-image:')) {
        if (!knownImages.has(reference.slice('g1brain-image:'.length))) throw new Error('图片占位符缺少原始图片，不能上传缺图 Markdown')
        return
      }
      let image: MaterialImage
      const data = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/iu.exec(reference)
      if (data?.[2]) image = materialImage(Buffer.from(data[2], 'base64'))
      else {
        if (/^[a-z][a-z0-9+.-]*:/iu.test(reference) || reference.startsWith('//') || reference.includes('?') || reference.includes('#')) {
          throw new Error('图片必须是资料目录内的相对路径、受支持的 data 图片或现有 HTTP(S) 链接')
        }
        let decoded: string
        try { decoded = decodeURIComponent(reference) } catch { throw new Error('图片路径编码无效') }
        image = materialImage(await load(decoded))
      }
      images.set(image.key, image)
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start === undefined || end === undefined) throw new Error('无法定位 Markdown 图片引用')
      const title = definition.title ? ` ${JSON.stringify(definition.title)}` : ''
      changes.push({ start, end, text: `![${altText(node.alt ?? '')}](<${image.placeholder}>${title})` })
      checkedDocument({ markdown: source, images: [...images.values()] }, maxBytes)
      return
    }
    if ('children' in node) for (const child of node.children) await walk(child)
  }
  await walk(tree)
  let markdown = source
  for (const change of changes.sort((a, b) => b.start - a.start)) {
    markdown = markdown.slice(0, change.start) + change.text + markdown.slice(change.end)
  }
  return checkedDocument({ markdown, images: [...images.values()] }, maxBytes)
}

/** Substitute confirmed public image URLs without changing other Markdown content.
 * @param document - preflighted content.
 * @param urls - verified static URL keyed by image digest.
 * @returns upload-ready Markdown, rejecting missing image receipts.
 */
export function uploadedMarkdown(document: MaterialDocument, urls: ReadonlyMap<string, string>): string {
  let markdown = document.markdown
  for (const image of document.images) {
    const url = urls.get(image.key)
    if (!url) throw new Error('图片尚未上传完成，不能提交不完整的 Markdown')
    markdown = markdown.replaceAll(image.placeholder, url.replace(/[()<>]/gu, character => encodeURIComponent(character)))
  }
  return markdown
}
