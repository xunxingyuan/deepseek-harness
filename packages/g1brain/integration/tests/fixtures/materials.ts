/** Small real Office containers with Chinese paragraphs, tables, sheets, and formulas. */
import { Buffer } from 'node:buffer'
import { zipSync, strToU8, unzipSync, strFromU8 } from 'fflate'
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

/** Small PNG used only by isolated import and static-resource fixtures. */
export const fixturePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDDsAAAAASUVORK5CYII=', 'base64')

/** Add two references to the same embedded picture between the introductory paragraph and table.
 * @returns DOCX bytes with Chinese alt text and content-addressable duplicate pictures.
 */
export function imageDocx(): Buffer {
  const parts = unzipSync(chineseDocx())
  const document = parts['word/document.xml']
  if (!document) throw new Error('Fixture document part missing')
  const drawing = '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="示意图" descr="工艺示意图"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="image.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
  parts['word/document.xml'] = strToU8(strFromU8(document).replace('<w:document ', '<w:document xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ')
    .replace('<w:tbl>', `${drawing}${drawing}<w:tbl>`))
  parts['word/_rels/document.xml.rels'] = strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/test.png"/></Relationships>')
  parts['word/media/test.png'] = fixturePng
  const contentTypes = parts['[Content_Types].xml']
  if (!contentTypes) throw new Error('Fixture content types missing')
  parts['[Content_Types].xml'] = strToU8(strFromU8(contentTypes).replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>'))
  return Buffer.from(zipSync(parts))
}

/** Attach an embedded picture to the first worksheet of an XLSX fixture.
 * @param source - valid XLSX bytes whose first sheet uses the standard SheetJS layout.
 * @returns an XLSX with a real worksheet-to-drawing-to-media relationship chain.
 */
export function imageWorkbook(source = chineseWorkbook()): Buffer {
  const parts = unzipSync(source)
  const sheet = parts['xl/worksheets/sheet1.xml']
  if (!sheet) throw new Error('Fixture worksheet missing')
  let text = strFromU8(sheet)
  if (!text.includes('xmlns:r=')) text = text.replace('<worksheet ', '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ')
  parts['xl/worksheets/sheet1.xml'] = strToU8(text.replace('</worksheet>', '<drawing r:id="rPicture"/></worksheet>'))
  parts['xl/worksheets/_rels/sheet1.xml.rels'] = strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rPicture" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>')
  parts['xl/drawings/drawing1.xml'] = strToU8('<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:row>1</xdr:row></xdr:from><xdr:to><xdr:col>2</xdr:col><xdr:row>4</xdr:row></xdr:to><xdr:pic><xdr:blipFill><a:blip r:embed="rImage"/></xdr:blipFill></xdr:pic><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>')
  parts['xl/drawings/_rels/drawing1.xml.rels'] = strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/test.png"/></Relationships>')
  parts['xl/media/test.png'] = fixturePng
  const types = parts['[Content_Types].xml']
  if (!types) throw new Error('Fixture content types missing')
  parts['[Content_Types].xml'] = strToU8(strFromU8(types).replace('</Types>', '<Default Extension="png" ContentType="image/png"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>'))
  return Buffer.from(zipSync(parts))
}
