/** Small real Office containers with Chinese paragraphs, tables, sheets, and formulas. */
import { Buffer } from 'node:buffer'
import { zipSync, strToU8 } from 'fflate'
import * as XLSX from 'xlsx'

/** Create DOCX bytes with interleaved Chinese paragraphs and a two-column table.
 * @returns A complete, non-encrypted DOCX package.
 */
export function chineseDocx(): Buffer {
  const files = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>生产周报：中文正文</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>设备</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>产量</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>一号炉</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>120 吨</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>表后说明：运行正常。</w:t></w:r></w:p></w:body></w:document>',
  }
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)]))))
}

/** Create Excel bytes with Chinese sheet names, special characters, and a formula without a cached value.
 * @param format - Modern XLSX or legacy XLS.
 * @returns The workbook in its declared binary format.
 */
export function chineseWorkbook(format: 'xlsx' | 'biff8' = 'xlsx'): Buffer {
  const workbook = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet([['设备', '产量', '备注'], ['一号炉', 120, '正常 | 稳定\n第二行'], ['二号炉', 95, '<说明>']])
  sheet['D1'] = { t: 'n', f: 'SUM(B2:B3)' }
  sheet['!ref'] = 'A1:D3'
  XLSX.utils.book_append_sheet(workbook, sheet, '生产数据')
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['检修记录'], ['二号炉例行检查']]), '检修记录')
  const bytes: unknown = XLSX.write(workbook, { type: 'buffer', bookType: format })
  if (!Buffer.isBuffer(bytes)) throw new Error('Workbook fixture writer did not return bytes')
  return bytes
}
