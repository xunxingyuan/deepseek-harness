/** Synthetic structured and explanatory Excel sheets for routing and precision regressions. */
import { Buffer } from 'node:buffer'
import * as XLSX from 'xlsx'

/** Read a typed SheetJS cell from the library's open worksheet index.
 * @param workbook - parsed test workbook.
 * @param sheet - worksheet name.
 * @param address - A1 cell address.
 * @returns the stored cell when present.
 */
export function workbookCell(workbook: XLSX.WorkBook, sheet: string, address: string): XLSX.CellObject | undefined {
  return workbook.Sheets[sheet]?.[address] as XLSX.CellObject | undefined
}

/** Encode a synthetic workbook for protocol and classifier tests.
 * @param workbook - test-owned workbook.
 * @param bookType - modern XLSX or legacy XLS.
 * @returns complete binary workbook bytes.
 */
export function workbookBytes(workbook: XLSX.WorkBook, bookType: 'xlsx' | 'biff8' = 'xlsx'): Buffer {
  const encoded: unknown = XLSX.write(workbook, { type: 'buffer', bookType })
  if (!Buffer.isBuffer(encoded)) throw new Error('Fixture writer did not return bytes')
  return encoded
}

/** Create regular records, optionally alongside a non-tabular explanatory worksheet.
 * @param notes - whether to include the explanatory sheet.
 * @returns workbook retaining text IDs, decimal strings, and a padded numeric ID.
 */
export function tableWorkbook(notes = true): Buffer {
  const workbook = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet([
    ['编号', '产量', '外部编号', '精确数值'], ['001', 120, '9007199254740993', '123.4500'],
    ['002', 95, '9007199254740995', '0.0000000001'],
  ])
  sheet.A3 = { t: 'n', v: 2, z: '000' }
  XLSX.utils.book_append_sheet(workbook, sheet, '生产数据')
  if (notes) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['操作说明'], ['先检查设备，再登记本周生产数据；这是说明正文，不是数据行。']]), '使用说明')
  return workbookBytes(workbook)
}
