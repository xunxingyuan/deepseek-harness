/** Stream-bounded Office archive validation and selected-part reads. */
import { Buffer } from 'node:buffer'
import { Unzip, UnzipInflate } from 'fflate'

/** Read selected Office parts after bounding the complete expanded archive, including unselected entries.
 * @param bytes - complete Office ZIP bytes.
 * @param requiredPart - mandatory main document part.
 * @param maxBytes - complete decompressed byte cap.
 * @param keep - parts to retain in memory.
 * @returns selected parts; invalid, duplicate or oversized archives throw before format conversion.
 */
export function officeParts(
  bytes: Buffer, requiredPart: string, maxBytes: number, keep: (name: string) => boolean,
): ReadonlyMap<string, Buffer> {
  let total = 0
  const found = new Set<string>()
  const result = new Map<string, Buffer>()
  const unzip = new Unzip((file) => {
    if (found.has(file.name)) throw new Error('Office 包含重复文件条目')
    found.add(file.name)
    if (file.originalSize !== undefined && file.originalSize > maxBytes) throw new Error('Office 解压内容超过文件大小上限')
    const retain = keep(file.name)
    const chunks: Uint8Array[] = []
    file.ondata = (error, chunk, final) => {
      if (error) throw error
      total += chunk.byteLength
      if (total > maxBytes) throw new Error('Office 解压内容超过文件大小上限')
      if (retain) chunks.push(chunk)
      if (final && retain) result.set(file.name, Buffer.concat(chunks))
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    unzip.push(bytes.subarray(offset, offset + 4096), offset + 4096 >= bytes.length)
  }
  if (!found.has(requiredPart)) throw new Error('文件不是有效的 Office 文档，或已加密；请另存为未加密的 DOCX/XLSX')
  return result
}
