/** Text extraction for local materials and UTF-8 Markdown ingestion; never decodes Office bytes as text. */
import { Buffer } from 'node:buffer'
import mammoth from 'mammoth'
import TurndownService from 'turndown'
import { gfm } from '@joplin/turndown-plugin-gfm'
import * as XLSX from 'xlsx'
import { checkedDocument, materialImage, type MaterialDocument, type MaterialImage } from './images.ts'
import { officeParts } from './office-archive.ts'
import { workbookImages, worksheetImageMarkdown } from './workbook-images.ts'

const markdown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
markdown.use(gfm)
markdown.remove(['script', 'style'])
const textExtensions = new Set(['.md', '.markdown', '.txt', '.json', '.csv', '.tsv'])
const oleSignature = Buffer.from('d0cf11e0a1b11ae1', 'hex')

function hasBlip(bytes: Buffer): boolean {
  for (let offset = 0; offset + 8 <= bytes.length;) {
    const version = bytes.readUInt16LE(offset) & 15
    const type = bytes.readUInt16LE(offset + 2)
    const length = bytes.readUInt32LE(offset + 4)
    if ((type === 0xf001 && length > 0) || type === 0xf007
      || [0xf018, 0xf01a, 0xf01b, 0xf01c, 0xf01d, 0xf01e, 0xf01f, 0xf029, 0xf02a].includes(type)) return true
    if (version === 15 && hasBlip(bytes.subarray(offset + 8, Math.min(offset + 8 + length, bytes.length)))) return true
    offset += 8 + length
  }
  return false
}

function rejectLegacyDrawings(bytes: Buffer): void {
  // SheetJS declares its embedded CFB adapter as any; only the inspected stream fields are used here.
  const reader = XLSX.CFB as { read: (data: Buffer, options: { type: 'buffer' }) => unknown }
  const cfb = reader.read(bytes, { type: 'buffer' })
  if (typeof cfb !== 'object' || cfb === null || !('FileIndex' in cfb) || !Array.isArray(cfb.FileIndex)) throw new Error('XLS 文件结构无效')
  const entries: readonly unknown[] = cfb.FileIndex
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || !('name' in entry) || typeof entry.name !== 'string'
      || !['Workbook', 'Book'].includes(entry.name) || !('content' in entry)) continue
    const content = entry.content
    if (!(content instanceof Uint8Array)) throw new Error('XLS 工作表流无效')
    const stream = Buffer.from(content)
    for (let offset = 0; offset + 4 <= stream.length;) {
      const id = stream.readUInt16LE(offset)
      const length = stream.readUInt16LE(offset + 2)
      if (id === 0x00eb || id === 0x00ec) {
        const chunks = [stream.subarray(offset + 4, offset + 4 + length)]
        let next = offset + 4 + length
        while (next + 4 <= stream.length && stream.readUInt16LE(next) === 0x003c) {
          const continuation = stream.readUInt16LE(next + 2)
          chunks.push(stream.subarray(next + 4, next + 4 + continuation))
          next += 4 + continuation
        }
        if (hasBlip(Buffer.concat(chunks))) throw new Error('旧版 XLS 包含图片，请先另存为 XLSX 后导入，避免图片丢失')
        offset = next
        continue
      }
      offset += 4 + length
    }
  }
}

function checked(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`提取正文超过上限（${maxBytes} bytes）；请拆分材料后重试`)
  return text
}

function validateArchive(bytes: Buffer, requiredPart: string, maxBytes: number): void {
  officeParts(bytes, requiredPart, maxBytes, () => false)
}

function decodeText(bytes: Buffer): string {
  let encoding = 'utf-8'
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le'
  if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be'
  let text: string
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes)
  } catch (error) {
    throw new Error('文本编码无法识别；请另存为 UTF-8，不能直接将 Office/PDF 原件当作文本读取', { cause: error })
  }
  if (/[\u0000-\u0008\u000e-\u001f]/u.test(text) || bytes.subarray(0, 2).toString() === 'PK' || text.startsWith('%PDF-')) {
    throw new Error('检测到二进制内容；请使用原始文件格式，或先导出为 UTF-8 Markdown')
  }
  return text
}

function cellText(cell: XLSX.CellObject | undefined): string {
  if (!cell) return ''
  // Cached results can be stale; a formula without one must not appear as an empty cell.
  const value = cell.f && cell.v === undefined ? `=${cell.f}（未计算）` : XLSX.utils.format_cell(cell)
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('\\', '\\\\').replaceAll('|', '\\|').replace(/\r\n?|\n/g, '<br>')
}

/** Parse bounded Office bytes without evaluating formulas or external links.
 * @param bytes - complete source workbook bytes.
 * @param extension - XLSX or XLS source extension.
 * @param maxExpandedBytes - maximum expanded archive bytes.
 * @returns the parsed workbook, retaining cached values and number formats.
 */
export function readWorkbook(bytes: Buffer, extension: string, maxExpandedBytes: number): XLSX.WorkBook {
  if (extension === '.xlsx') validateArchive(bytes, 'xl/workbook.xml', maxExpandedBytes)
  else if (extension !== '.xls' || !bytes.subarray(0, 8).equals(oleSignature)) throw new Error('文件不是有效的 XLS/XLSX；请另存为未加密的 XLSX 后重试')
  if (extension === '.xls') rejectLegacyDrawings(bytes)
  return XLSX.read(Buffer.from(bytes), { type: 'buffer', cellDates: true, cellFormula: true, cellNF: true, sheetStubs: true })
}

/** Render selected workbook sheets as bounded Markdown without changing source cells.
 * @param workbook - parsed workbook, optionally narrowed to selected sheets.
 * @param maxBytes - complete UTF-8 output limit.
 * @param images - embedded pictures grouped by original worksheet name.
 * @returns readable worksheet text with cached formula results.
 */
export function workbookMarkdown(
  workbook: XLSX.WorkBook, maxBytes: number, images: ReadonlyMap<string, readonly MaterialImage[]> = new Map(),
): string {
  const parts: string[] = []
  let size = 0
  const append = (value: string) => {
    size += Buffer.byteLength(value, 'utf8')
    if (size > maxBytes) throw new Error(`提取正文超过上限（${maxBytes} bytes）；请拆分工作表后重试`)
    parts.push(value)
  }
  if (!workbook.SheetNames.length) throw new Error('Excel 文件没有工作表')
  for (const name of workbook.SheetNames) {
    append(`## 工作表：${name.replace(/[\r\n]/g, ' ')}\n\n`)
    const sheet = workbook.Sheets[name]
    if (sheet === undefined) throw new Error(`Excel 缺少工作表内容：${name}`)
    if (!sheet['!ref']) { append('（空工作表）\n\n'); append(worksheetImageMarkdown(images.get(name) ?? [])); continue }
    append(`单元格范围：${sheet['!ref']}\n\n`)
    const range = XLSX.utils.decode_range(sheet['!ref'])
    if (range.s.r < 0 || range.s.c < 0 || range.e.r > 1048575 || range.e.c > 16383) throw new Error('Excel 工作表范围无效')
    const columns = range.e.c - range.s.c + 1
    append('| ' + Array.from({ length: columns }, (_, index) => XLSX.utils.encode_col(range.s.c + index)).join(' | ') + ' |\n')
    append('| ' + Array.from({ length: columns }, () => '---').join(' | ') + ' |\n')
    for (let row = range.s.r; row <= range.e.r; row += 1) {
      const values = Array.from({ length: columns }, (_, index) => {
        const cell = sheet[XLSX.utils.encode_cell({ r: row, c: range.s.c + index })] as XLSX.CellObject | undefined
        return cellText(cell)
      })
      append('| ' + values.join(' | ') + ' |\n')
    }
    append('\n')
    append(worksheetImageMarkdown(images.get(name) ?? []))
  }
  append('注：公式使用文件保存的结果；没有缓存结果时显示公式（未计算）。不执行公式、宏、外部链接或图片 OCR。\n')
  return parts.join('')
}

/** Extract bounded Markdown without modifying sources or loading externally referenced files.
 * @param bytes - Complete source file within the configured file limit.
 * @param extension - Lowercase original extension, including the dot.
 * @param maxOutputBytes - UTF-8 limit for the complete extracted text.
 * @param maxExpandedBytes - Limit for the complete decompressed Office archive.
 * @returns Unicode text or Markdown; rejects unsupported, malformed, encrypted, or oversized input.
 */
export async function extractMaterial(bytes: Buffer, extension: string, maxOutputBytes: number, maxExpandedBytes: number): Promise<string> {
  return (await extractMaterialDocument(bytes, extension, maxOutputBytes, maxExpandedBytes)).markdown
}

/** Extract Markdown and image bytes without uploading, OCR, remote reads, or source changes.
 * @param bytes - complete source file bytes.
 * @param extension - lowercase source suffix.
 * @param maxOutputBytes - complete text-and-images output limit.
 * @param maxExpandedBytes - complete expanded Office archive limit.
 * @returns preflighted Markdown and deduplicated image attachments.
 */
export async function extractMaterialDocument(
  bytes: Buffer, extension: string, maxOutputBytes: number, maxExpandedBytes: number,
): Promise<MaterialDocument> {
  if (extension === '.docx') {
    validateArchive(bytes, 'word/document.xml', maxExpandedBytes)
    const images = new Map<string, MaterialImage>()
    const result = await mammoth.convertToHtml({ buffer: bytes }, {
      externalFileAccess: false,
      includeEmbeddedStyleMap: false,
      convertImage: mammoth.images.imgElement(async (image) => {
        const attachment = materialImage(await image.readAsBuffer())
        images.set(attachment.key, attachment)
        checkedDocument({ markdown: '', images: [...images.values()] }, maxOutputBytes)
        return { src: attachment.placeholder }
      }),
    })
    if (result.messages.some(message => message.type === 'error')) throw new Error('Word 正文解析失败；请在 Word 中另存为 DOCX 后重试')
    const body = markdown.turndown(checked(result.value, maxExpandedBytes))
    if (!body.trim()) throw new Error('Word 中没有可提取的正文；图片或扫描件需要先做 OCR')
    return checkedDocument({ markdown: body + '\n\n注：提取正文、表格与嵌入图片；不执行图片 OCR，不保留原始页面版式。\n', images: [...images.values()] }, maxOutputBytes)
  }
  if (extension === '.xlsx' || extension === '.xls') {
    const workbook = readWorkbook(bytes, extension, maxExpandedBytes)
    const images = extension === '.xlsx' ? workbookImages(bytes, maxExpandedBytes) : new Map<string, readonly MaterialImage[]>()
    const unique = new Map([...images.values()].flat().map(image => [image.key, image]))
    return checkedDocument({ markdown: workbookMarkdown(workbook, maxOutputBytes, images), images: [...unique.values()] }, maxOutputBytes)
  }
  if (!textExtensions.has(extension)) throw new Error(`不支持直接提取 ${extension} 正文；请先导出为 DOCX、XLSX 或 UTF-8 Markdown，不能直接上传二进制内容到 Markdown 文档库`)
  return { markdown: checked(decodeText(bytes), maxOutputBytes), images: [] }
}
