/** Worksheet-bound embedded XLSX pictures; relationships never read external files or URLs. */
import { Buffer } from 'node:buffer'
import { posix } from 'node:path'
import { XMLParser } from 'fast-xml-parser'
import { materialImage, type MaterialImage } from './images.ts'
import { officeParts } from './office-archive.ts'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function rows(value: unknown): Record<string, unknown>[] {
  return (Array.isArray(value) ? value : [value]).filter(record)
}
function xml(parts: ReadonlyMap<string, Buffer>, name: string): Record<string, unknown> {
  const bytes = parts.get(name)
  if (!bytes) throw new Error(`Excel 图片引用的部件不存在：${name}`)
  const source = bytes.toString('utf8')
  if (/<!DOCTYPE|<!ENTITY/iu.test(source)) throw new Error('Office XML 不允许包含外部实体或文档类型定义')
  const parsed: unknown = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true,
    processEntities: true, parseTagValue: false, parseAttributeValue: false }).parse(source)
  if (!record(parsed)) throw new Error('Excel 图片 XML 内容无效')
  return parsed
}
function related(parts: ReadonlyMap<string, Buffer>, part: string, id: string): string {
  const relations = xml(parts, posix.join(posix.dirname(part), '_rels', `${posix.basename(part)}.rels`)).Relationships
  const matches = rows(record(relations) ? relations.Relationship : undefined).filter(row => row.Id === id)
  const relation = matches[0]
  if (matches.length !== 1 || !relation || typeof relation.Target !== 'string') throw new Error('Excel 图片关系引用缺失或不唯一')
  let target: string
  try { target = decodeURIComponent(relation.Target) } catch { throw new Error('Excel 图片引用路径编码无效') }
  if (relation.TargetMode === 'External' || /[\\\0?#]/u.test(target) || /^[a-z][a-z0-9+.-]*:/iu.test(target)) throw new Error('Excel 外部图片不能自动读取，请先嵌入图片后重试')
  const name = target.startsWith('/') ? posix.normalize(target).slice(1) : posix.normalize(posix.join(posix.dirname(part), target))
  if (!name.startsWith('xl/') || !parts.has(name)) throw new Error('Excel 图片引用超出文档包或内容缺失')
  return name
}
function descendants(value: unknown, name: string): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(item => descendants(item, name))
  if (!record(value)) return []
  return Object.entries(value).flatMap(([key, child]) => key === name ? rows(child) : descendants(child, name))
}

/** Extract images by worksheet rather than copying unreferenced media from the ZIP.
 * @param bytes - XLSX source bytes.
 * @param maxBytes - complete expanded Office archive limit.
 * @returns ordered image references for every sheet with embedded pictures.
 */
export function workbookImages(bytes: Buffer, maxBytes: number): ReadonlyMap<string, readonly MaterialImage[]> {
  const parts = officeParts(bytes, 'xl/workbook.xml', maxBytes, name => name.startsWith('xl/'))
  const workbook = xml(parts, 'xl/workbook.xml').workbook
  const sheets = record(workbook) && record(workbook.sheets) ? rows(workbook.sheets.sheet) : []
  const result = new Map<string, readonly MaterialImage[]>()
  for (const sheet of sheets) {
    if (typeof sheet.name !== 'string' || typeof sheet.id !== 'string') throw new Error('Excel 工作表名称或关系 ID 无效')
    const part = related(parts, 'xl/workbook.xml', sheet.id)
    const images: MaterialImage[] = []
    for (const drawing of descendants(xml(parts, part), 'drawing')) {
      if (typeof drawing.id !== 'string') throw new Error('Excel 绘图引用缺少 ID')
      const drawingPart = related(parts, part, drawing.id)
      for (const blip of descendants(xml(parts, drawingPart), 'blip')) {
        if (typeof blip.link === 'string') throw new Error('Excel 外部图片不能自动读取，请先嵌入图片后重试')
        if (typeof blip.embed !== 'string') throw new Error('Excel 图片缺少嵌入引用')
        const imagePart = related(parts, drawingPart, blip.embed)
        const image = parts.get(imagePart)
        if (!image) throw new Error('Excel 图片内容缺失')
        images.push(materialImage(image))
      }
    }
    if (images.length) result.set(sheet.name, images)
  }
  return result
}

/** Render extracted worksheet pictures as Markdown placeholders, without claiming to OCR their content.
 * @param images - ordered embedded pictures for one worksheet.
 * @returns Markdown image references.
 */
export function worksheetImageMarkdown(images: readonly MaterialImage[]): string {
  return images.length ? `\n### 工作表图片\n\n${images.map((image, index) => `![图片 ${index + 1}](<${image.placeholder}>)`).join('\n\n')}\n` : ''
}
