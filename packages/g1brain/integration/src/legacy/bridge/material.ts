/** Text extraction for local materials and UTF-8 Markdown ingestion; never decodes Office bytes as text. */
import { Buffer } from 'node:buffer'
import { Unzip, UnzipInflate } from 'fflate'
import mammoth from 'mammoth'
import TurndownService from 'turndown'
import { gfm } from '@joplin/turndown-plugin-gfm'
import * as XLSX from 'xlsx'

const markdown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
markdown.use(gfm)
markdown.remove(['img', 'script', 'style'])
const textExtensions = new Set(['.md', '.markdown', '.txt', '.json', '.csv', '.tsv'])
const oleSignature = Buffer.from('d0cf11e0a1b11ae1', 'hex')

function checked(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`提取正文超过上限（${maxBytes} bytes）；请拆分材料后重试`)
  return text
}

function validateArchive(bytes: Buffer, requiredPart: string, maxBytes: number): void {
  let total = 0
  const found = new Set<string>()
  const unzip = new Unzip((file) => {
    if (file.name === requiredPart) found.add(file.name)
    if (file.originalSize !== undefined && file.originalSize > maxBytes) throw new Error('Office 解压内容超过文件大小上限')
    file.ondata = (error, chunk) => {
      if (error) throw error
      total += chunk.byteLength
      if (total > maxBytes) throw new Error('Office 解压内容超过文件大小上限')
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    unzip.push(bytes.subarray(offset, offset + 4096), offset + 4096 >= bytes.length)
  }
  if (!found.has(requiredPart)) throw new Error('文件不是有效的 Office 文档，或已加密；请另存为未加密的 DOCX/XLSX')
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
  return XLSX.read(Buffer.from(bytes), { type: 'buffer', cellDates: true, cellFormula: true, cellNF: true, sheetStubs: true })
}

/** Render selected workbook sheets as bounded Markdown without changing source cells.
 * @param workbook - parsed workbook, optionally narrowed to selected sheets.
 * @param maxBytes - complete UTF-8 output limit.
 * @returns readable worksheet text with cached formula results.
 */
export function workbookMarkdown(workbook: XLSX.WorkBook, maxBytes: number): string {
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
    if (!sheet['!ref']) { append('（空工作表）\n\n'); continue }
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
  if (extension === '.docx') {
    validateArchive(bytes, 'word/document.xml', maxExpandedBytes)
    const result = await mammoth.convertToHtml({ buffer: bytes }, {
      externalFileAccess: false,
      includeEmbeddedStyleMap: false,
      convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '', alt: '图片（未提取）' })),
    })
    if (result.messages.some(message => message.type === 'error')) throw new Error('Word 正文解析失败；请在 Word 中另存为 DOCX 后重试')
    const body = markdown.turndown(checked(result.value, maxExpandedBytes))
    if (!body.trim()) throw new Error('Word 中没有可提取的正文；图片或扫描件需要先做 OCR')
    return checked(body + '\n\n注：仅提取正文与表格，不包含图片 OCR 或原始版式。\n', maxOutputBytes)
  }
  if (extension === '.xlsx' || extension === '.xls') {
    return checked(workbookMarkdown(readWorkbook(bytes, extension, maxExpandedBytes), maxOutputBytes), maxOutputBytes)
  }
  if (!textExtensions.has(extension)) throw new Error(`不支持直接提取 ${extension} 正文；请先导出为 DOCX、XLSX 或 UTF-8 Markdown，不能直接上传二进制内容到 Markdown 文档库`)
  return checked(decodeText(bytes), maxOutputBytes)
}
