import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { planExcel } from '../src/tables/excel.ts'
import { workbookBytes, workbookCell, tableWorkbook } from './fixtures/table-workbooks.ts'

const limit = 50 * 1024 * 1024

function single(rows: Array<Array<string | number | null>>, mutate?: (sheet: XLSX.WorkSheet) => void) {
  const workbook = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  mutate?.(sheet)
  XLSX.utils.book_append_sheet(workbook, sheet, '测试')
  return workbookBytes(workbook)
}

describe('Excel worksheet routing', () => {
  it('splits regular tables from explanation sheets without changing the original bytes', () => {
    const source = tableWorkbook()
    const before = Buffer.from(source)
    const plan = planExcel(source, '.xlsx', limit)
    expect(plan.sheets.map(sheet => [sheet.name, sheet.route])).toEqual([['生产数据', 'table'], ['使用说明', 'document']])
    expect(plan.documentText).toContain('这是说明正文')
    expect(plan.documentText).not.toContain('9007199254740993')
    const workbook = XLSX.read(plan.tableBytes, { type: 'buffer' })
    expect(workbook.SheetNames).toEqual(['生产数据'])
    expect(workbookCell(workbook, '生产数据', 'A2')?.v).toBe('001')
    expect(workbook.Sheets['生产数据']?.A3).toMatchObject({ t: 's', v: '002' })
    expect(workbookCell(workbook, '生产数据', 'C2')?.v).toBe('9007199254740993')
    expect(workbookCell(workbook, '生产数据', 'D3')?.v).toBe('0.0000000001')
    expect(source).toEqual(before)
  })

  it('supports legacy XLS without routing binary bytes into the vector library', () => {
    const workbook = XLSX.read(tableWorkbook(false), { type: 'buffer' })
    const plan = planExcel(workbookBytes(workbook, 'biff8'), '.xls', limit)
    expect(plan.sheets[0]).toMatchObject({ route: 'table', rowCount: 2 })
    expect(plan.documentText).toBeUndefined()
    expect(plan.tableBytes?.subarray(0, 2).toString()).toBe('PK')
  })

  it.each([
    [['名称', '名称'], ['甲', '乙'], ['丙', '丁']],
    [['设备', null, '数量'], ['炉一', '正常', 1]],
    [['项目', '数值'], ['产量', 1], ['合计', 1]],
    [['名称', '数值'], ['设备', 1], ['名称', '数值']],
  ].map(rows => ({ rows })))('keeps duplicate, missing, total or repeated headers in the document route', ({ rows }) => {
    const plan = planExcel(single(rows), '.xlsx', limit)
    expect(plan.sheets[0]?.route).toBe('document')
    expect(plan.tableBytes).toBeUndefined()
  })

  it('keeps merged data and single-column prose in the document route', () => {
    const merged = single([['设备', '数量'], ['炉一', 2]], (sheet) => { sheet['!merges'] = [XLSX.utils.decode_range('A2:B2')] })
    expect(planExcel(merged, '.xlsx', limit).sheets[0]?.route).toBe('document')
    expect(planExcel(single([['说明'], ['这是一段正文']]), '.xlsx', limit).sheets[0]?.route).toBe('document')
  })

  it('keeps an ambiguous title spanning outside the record columns in the document route', () => {
    const bytes = single([['生产数据', null, null, null], [], [null, null, '设备', '数量'], [null, null, '炉一', 2]],
      (sheet) => { sheet['!merges'] = [XLSX.utils.decode_range('A1:D1')] })
    const plan = planExcel(bytes, '.xlsx', limit)
    expect(plan.sheets[0]?.route).toBe('document')
  })

  it('strips a merged preamble or leading empty columns from a regular table', () => {
    const title = single([['生产数据', null], [], ['设备', '数量'], ['炉一', 2]],
      (sheet) => { sheet['!merges'] = [XLSX.utils.decode_range('A1:B1')] })
    const padded = single([[null, null, '设备', '数量'], [null, null, '炉一', 2]])
    for (const source of [title, padded]) {
      const plan = planExcel(source, '.xlsx', limit)
      expect(plan.sheets[0]?.route).toBe('table')
      expect(workbookCell(XLSX.read(plan.tableBytes, { type: 'buffer' }), '测试', 'A1')?.v).toBe('设备')
    }
  })

  it('does not execute formulas and imports only saved cached values', () => {
    const source = single([['设备', '数量'], ['炉一', 2]], (sheet) => { sheet.B2 = { t: 'n', f: '1+1', v: 2 } })
    const plan = planExcel(source, '.xlsx', limit)
    const workbook = XLSX.read(plan.tableBytes, { type: 'buffer', cellFormula: true })
    expect(workbook.Sheets['测试']?.B2).toMatchObject({ t: 'n', v: 2 })
    expect(workbookCell(workbook, '测试', 'B2')?.f).toBeUndefined()
  })

  it('rejects unsafe numeric identifiers and invalid Office containers before any upload', () => {
    const source = single([['设备', '数量'], ['炉一', 9007199254740992]])
    expect(() => planExcel(source, '.xlsx', limit)).toThrow('安全精度')
    expect(() => planExcel(Buffer.from('not Excel'), '.xlsx', limit)).toThrow()
    expect(() => planExcel(tableWorkbook(), '.xlsx', 100)).toThrow('上限')
  })
})
