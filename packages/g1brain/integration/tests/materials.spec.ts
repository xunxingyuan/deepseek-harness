import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { extractMaterial } from '../src/legacy/bridge/material.ts'
import { openWorkspaceScope } from '../src/legacy/bridge/scope.ts'
import { createG1BrainTools } from '../src/legacy/bridge/tools.ts'
import { createG1BrainClient } from '../src/legacy/g1brain/client.ts'
import { chineseDocx, chineseWorkbook } from './fixtures/materials.ts'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const extract = (bytes: Buffer, extension: string, maxBytes = 200_000) => extractMaterial(bytes, extension, maxBytes, 1_000_000)

describe('G1brain material text extraction', () => {
  it('extracts DOCX Chinese paragraphs and tables in document order, not ZIP bytes', async () => {
    const text = await extract(chineseDocx(), '.docx')
    expect(text).toContain('生产周报：中文正文')
    expect(text).toMatch(/\|.*设备.*\|.*产量.*\|/)
    expect(text).toMatch(/\|.*一号炉.*\|.*120 吨.*\|/)
    expect(text.indexOf('中文正文')).toBeLessThan(text.indexOf('一号炉'))
    expect(text.indexOf('一号炉')).toBeLessThan(text.indexOf('表后说明'))
    expect(text).not.toContain('\ufffd')
    expect(text).not.toContain('PK\u0003\u0004')
  })

  it.each(['xlsx', 'biff8'] as const)('extracts %s Chinese sheets, cells, and escaped Markdown tables', async (format) => {
    const text = await extract(chineseWorkbook(format), format === 'xlsx' ? '.xlsx' : '.xls')
    expect(text).toContain('## 工作表：生产数据')
    expect(text).toContain('## 工作表：检修记录')
    expect(text).toContain('一号炉 | 120')
    expect(text).toContain('正常 \\| 稳定<br>第二行')
    expect(text).toContain('&lt;说明&gt;')
    expect(text).toContain('二号炉例行检查')
    expect(text).not.toContain('\ufffd')
  })

  it('labels formulas without cached results instead of silently replacing them with blank cells', async () => {
    expect(await extract(chineseWorkbook(), '.xlsx')).toContain('=SUM(B2:B3)（未计算）')
  })

  it.each([
    Buffer.from('中文 UTF-8'),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文 UTF-16', 'utf16le')]),
    Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('中文 UTF-16', 'utf16le').swap16()]),
  ])('decodes supported text encodings without replacement characters', async (bytes) => {
    expect(await extract(bytes, '.txt')).toMatch(/^中文 UTF-/)
  })

  it('rejects unsupported, mislabeled, corrupt, and undecodable files', async () => {
    await expect(extract(Buffer.from('d0cf11e0a1b11ae1', 'hex'), '.doc')).rejects.toThrow('先导出')
    await expect(extract(chineseDocx(), '.txt')).rejects.toThrow()
    await expect(extract(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), '.txt')).rejects.toThrow('UTF-8')
    await expect(extract(Buffer.from('not an Office package'), '.docx')).rejects.toThrow()
    await expect(extract(chineseDocx(), '.xlsx')).rejects.toThrow('不是有效')
    await expect(extract(Buffer.from('not Excel'), '.xls')).rejects.toThrow('不是有效')
    await expect(extract(Buffer.from('hello\0world'), '.md')).rejects.toThrow('二进制')
  })

  it('enforces UTF-8 output limits without truncating multibyte text', async () => {
    expect(await extract(Buffer.from('中文'), '.txt', 6)).toBe('中文')
    await expect(extract(Buffer.from('中文'), '.txt', 5)).rejects.toThrow('超过上限')
    await expect(extract(chineseDocx(), '.docx', 20)).rejects.toThrow('超过上限')
    await expect(extract(chineseWorkbook(), '.xlsx', 20)).rejects.toThrow('超过上限')
  })

  it('rejects oversized expanded Office archives before the format parser runs', async () => {
    const bytes = Buffer.from(zipSync({ 'word/document.xml': strToU8('中'.repeat(10_000)) }))
    await expect(extractMaterial(bytes, '.docx', 100_000, 1000)).rejects.toThrow('解压内容超过')
  })

  it('rejects encrypted XLSX files rather than returning binary text', async () => {
    const bytes = await readFile(new URL('../../../skill/skill-office/tests/fixtures/encrypted.xlsx', import.meta.url))
    await expect(extract(bytes, '.xlsx')).rejects.toThrow()
  })

  it('bounds whole upload batches and rejects aliases and directory escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'g1brain-material-limits-'))
    roots.push(root)
    await writeFile(join(root, '一.md'), '中文')
    await writeFile(join(root, '二.md'), '中文')
    const scope = await openWorkspaceScope(root, { maxFileBytes: 10 })
    await expect(scope.prepareUploads(['一.md', '二.md'])).rejects.toThrow('本批次正文总量')
    await expect(scope.prepareUploads(['一.md', './一.md'])).rejects.toThrow('上传名称重复')
    await expect(scope.read('../outside.md')).rejects.toThrow('超出')
    await expect(scope.read('一.md', 5)).rejects.toThrow('正文超过')
  })

  it('reads and uploads the same UTF-8 Office text while preserving original bytes and source names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'g1brain-materials-'))
    roots.push(root)
    const word = chineseDocx()
    const excel = chineseWorkbook()
    await writeFile(join(root, '中文 周报.docx'), word)
    await writeFile(join(root, '中文 周报.xlsx'), excel)
    const scope = await openWorkspaceScope(root)
    const uploads: Array<{ name: string; contents: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      expect(decodeURIComponent(new URL(url).pathname)).toBe('/mdApi/v1/md/collections/资料库_API_ID/mds')
      const body = init.body
      if (!(body instanceof FormData)) throw new Error('Expected multipart upload')
      const file = body.get('file')
      if (!(file instanceof File)) throw new Error('Expected a file')
      expect(file.type).toBe('text/markdown; charset=utf-8')
      uploads.push({ name: file.name, contents: await file.text() })
      return Response.json({ data: { id: uploads.length } })
    }))
    const client = createG1BrainClient({ baseUrl: 'http://127.0.0.1', authMode: 'local-dev', localUserId: 'developer', localClientId: 'test', tenantId: '000000', clientId: 'test', clientSecret: '', publicKey: '', timeoutMs: 1000 })
    const tools = createG1BrainTools({ scope, client })
    const reader = tools.find(tool => tool.name === 'g1brain_read_selected_file')!
    const uploader = tools.find(tool => tool.name === 'g1brain_upload_selected_files')!
    const read = await reader.execute({ path: '中文 周报.docx' })
    expect(read.isError).not.toBe(true)
    const result = await uploader.execute({ collectionName: '资料库_API_ID', files: ['中文 周报.docx', '中文 周报.xlsx'] })
    expect(result.isError).not.toBe(true)
    expect(uploads.map(upload => upload.name)).toEqual(['中文 周报.docx.md', '中文 周报.xlsx.md'])
    expect(uploads[0]!.contents).toBe(read.content[0]!.text)
    expect(uploads[1]!.contents).toContain('二号炉例行检查')
    expect(await readFile(join(root, '中文 周报.docx'))).toEqual(word)
    expect(await readFile(join(root, '中文 周报.xlsx'))).toEqual(excel)
    uploads.length = 0
    await writeFile(join(root, '损坏.docx'), 'bad file')
    expect((await uploader.execute({ collectionName: '资料库_API_ID', files: ['中文 周报.docx', '损坏.docx'] })).isError).toBe(true)
    expect(uploads).toEqual([])
    await writeFile(join(root, '中文 周报.docx.md'), '# another source')
    expect((await uploader.execute({ collectionName: '资料库_API_ID', files: ['中文 周报.docx', '中文 周报.docx.md'] })).isError).toBe(true)
    expect(uploads).toEqual([])
  })
})
