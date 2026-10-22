/** Conservative worksheet routing; generated XLSX files contain cached values, never executable formulas. */
import { Buffer } from 'node:buffer'
import * as XLSX from 'xlsx'
import { readWorkbook, workbookMarkdown } from '../legacy/bridge/material.ts'

/** One worksheet's automatic routing decision. */
interface SheetSummary {
  readonly name: string
  readonly reason: string
  readonly rowCount: number
  readonly columns: readonly string[]
}

/** Routing evidence; only a structured worksheet has a validated header and data range. */
export type SheetDecision = SheetSummary & (
  { readonly route: 'table'; readonly headerRow: number; readonly range: XLSX.Range }
  | { readonly route: 'document' | 'empty' }
)

/** Prepared workbook derivatives; the source file is never modified. */
export interface ExcelPlan {
  readonly sheets: readonly SheetDecision[]
  readonly tableBytes?: Buffer
  readonly documentText?: string
}

function value(cell: XLSX.CellObject | undefined): string {
  return cell?.v === undefined ? '' : String(cell.v).trim()
}

function classify(name: string, sheet: XLSX.WorkSheet): SheetDecision {
  const cells = Object.keys(sheet).filter(key => /^[A-Z]+[1-9]\d*$/u.test(key) && value(sheet[key] as XLSX.CellObject))
  const document = (reason: string): SheetDecision => ({ name, route: 'document', reason, rowCount: 0, columns: [] })
  if (cells.length === 0) return { name, route: 'empty', reason: '空工作表', rowCount: 0, columns: [] }
  const positions = cells.map(key => XLSX.utils.decode_cell(key))
  const first = positions.reduce((min, position) => Math.min(min, position.r), 1048575)
  const last = positions.reduce((max, position) => Math.max(max, position.r), first)
  const left = positions.reduce((min, position) => Math.min(min, position.c), 16383)
  const right = positions.reduce((max, position) => Math.max(max, position.c), 0)
  if (last - first > 100020 || right - left >= 200 || (last - first + 1) * (right - left + 1) > 2_000_000) {
    throw new Error(`${name} 超过导入保护上限（100000 条记录、200 列、200 万个单元格）；请拆分工作表`)
  }
  if (right === left) return document('单列说明或正文，按文档处理')
  const at = (row: number, column: number): XLSX.CellObject | undefined =>
    sheet[XLSX.utils.encode_cell({ r: row, c: column })] as XLSX.CellObject | undefined
  let header = -1
  let columns: string[] = []
  for (let row = first; row <= Math.min(last - 1, first + 19); row++) {
    const candidate = Array.from({ length: right - left + 1 }, (_, index) => at(row, left + index))
    const labels = candidate.map(value)
    const occupied = labels.filter(Boolean).length
    if (occupied < 2) {
      const title = (sheet['!merges'] ?? []).some(range => range.s.r === row && range.e.r === row && range.s.c <= left && range.e.c >= right)
      if (!occupied || title) continue
      return document('首行内容与表头含义不明确，保留为文档待核对')
    }
    if (candidate.every((cell, index) => cell?.t === 's' && !cell.f && labels[index] && labels[index].length <= 100)
      && new Set(labels.map(label => label.toLowerCase())).size === labels.length) { header = row; columns = labels; break }
    return document('表头包含空列、重复字段或非文本字段，保留为文档待核对')
  }
  if (header < 0) return document('无法确定完整且不重复的单行表头，保留为文档待核对')
  if ((sheet['!merges'] ?? []).some(range => range.e.r >= header && range.s.r <= last && range.e.c >= left && range.s.c <= right)) {
    return document('表头或数据区存在合并单元格，保留为文档待整理')
  }
  let rowCount = 0
  for (let row = header + 1; row <= last; row++) {
    const rowCells = Array.from({ length: columns.length }, (_, index) => at(row, left + index))
    const values = rowCells.map(value)
    const occupied = values.filter(Boolean).length
    if (!occupied) continue
    if (occupied < Math.ceil(columns.length / 2) || values.every((text, index) => text === columns[index])
      || /^(?:合计|总计|小计|说明|备注)(?:[:：].*)?$/u.test(values.find(Boolean) ?? '')) {
      return document('数据区包含说明、重复表头、汇总或不规则记录，保留为文档待整理')
    }
    if (rowCells.some(cell => cell?.f && cell.v === undefined)) return document('包含未计算公式，不能作为确定的表格数值导入')
    if (rowCells.some(cell => cell?.t === 'e')) throw new Error(`${name} 包含 Excel 错误单元格，请修正后导入`)
    if (rowCells.some(cell => cell?.t === 'n' && typeof cell.v === 'number' && Number.isInteger(cell.v) && !Number.isSafeInteger(cell.v))) {
      throw new Error(`${name} 包含超过安全精度的数值整数，请将编号或大整数保存为文本后导入`)
    }
    rowCount++
  }
  if (!rowCount) return document('只有表头，没有可导入记录')
  if (rowCount > 100000) throw new Error(`${name} 超过 100000 条记录，请拆分文件`)
  return { name, route: 'table', reason: '完整表头与规则行记录', headerRow: header + 1, rowCount, columns,
    range: { s: { r: header, c: left }, e: { r: last, c: right } } }
}

/** Split structured and explanatory sheets, preserving formatted values and cached results.
 * @param bytes - source XLSX or XLS bytes.
 * @param extension - lowercase source suffix.
 * @param maxBytes - source expansion and complete generated-text limit.
 * @returns routing evidence, a data-only XLSX derivative, and explanatory Markdown where present.
 */
export function planExcel(bytes: Buffer, extension: string, maxBytes: number): ExcelPlan {
  const workbook = readWorkbook(bytes, extension, maxBytes)
  if (!workbook.SheetNames.length || workbook.SheetNames.length > 50) throw new Error('Excel 须包含 1～50 个工作表')
  const sheets = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name]
    if (!sheet) throw new Error(`Excel 缺少工作表：${name}`)
    return classify(name, sheet)
  })
  const tables = XLSX.utils.book_new()
  const notes = XLSX.utils.book_new()
  for (const decision of sheets) {
    const source = workbook.Sheets[decision.name]
    if (!source) throw new Error(`Excel 缺少工作表：${decision.name}`)
    if (decision.route === 'document') XLSX.utils.book_append_sheet(notes, source, decision.name)
    if (decision.route !== 'table') continue
    const range = decision.range
    const header = decision.headerRow - 1
    const output: XLSX.WorkSheet = {}
    // Shift only the preamble; retain cell types and number formats while omitting formulas and external references.
    for (const key of Object.keys(source).filter(key => /^[A-Z]+[1-9]\d*$/u.test(key))) {
      const position = XLSX.utils.decode_cell(key)
      if (position.r < header || position.c < range.s.c || position.c > range.e.c || position.r > range.e.r) continue
      const cell = source[key] as XLSX.CellObject | undefined
      if (!cell || cell.v === undefined) continue
      const formatted = cell.t === 'n' ? XLSX.utils.format_cell(cell) : ''
      const paddedIdentifier = /^0\d+$/u.test(formatted)
      output[XLSX.utils.encode_cell({ r: position.r - header, c: position.c - range.s.c })] = {
        t: paddedIdentifier ? 's' : cell.t, v: paddedIdentifier ? formatted : cell.v, ...(cell.z === undefined ? {} : { z: cell.z }),
      }
    }
    output['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: range.e.r - header, c: range.e.c - range.s.c } })
    XLSX.utils.book_append_sheet(tables, output, decision.name)
  }
  const encoded: unknown = tables.SheetNames.length ? XLSX.write(tables, { type: 'buffer', bookType: 'xlsx' }) : undefined
  if (encoded !== undefined && !Buffer.isBuffer(encoded)) throw new Error('Excel 导出未返回二进制内容')
  return { sheets, ...(encoded === undefined ? {} : { tableBytes: encoded }),
    ...(notes.SheetNames.length ? { documentText: workbookMarkdown(notes, maxBytes) } : {}) }
}
