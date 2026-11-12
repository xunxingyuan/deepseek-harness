import { Buffer } from 'node:buffer'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import * as XLSX from 'xlsx'
import { extractMaterialDocument } from '../src/legacy/bridge/material.ts'
import { materialImage, markdownImages } from '../src/legacy/bridge/images.ts'
import { openWorkspaceScope } from '../src/legacy/bridge/scope.ts'
import { createG1BrainClient } from '../src/legacy/g1brain/client.ts'
import { createG1BrainTools } from '../src/legacy/bridge/tools.ts'
import { planExcel } from '../src/tables/excel.ts'
import { fixturePng, imageDocx, imageWorkbook } from './fixtures/materials.ts'
import { tableWorkbook } from './fixtures/table-workbooks.ts'
import { pictureCategories } from './fixtures/picture-categories.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const limit = 1_000_000
const image = materialImage(fixturePng)

function requestUrl(input: string | URL | Request): URL { return new URL(input instanceof Request ? input.url : input) }

function backend(failure?: 'public-401' | 'wrong-bytes' | 'cross-origin') {
  const uploaded = new Set<string>()
  const uploadCategories: string[] = []
  const categories = pictureCategories()
  const documents: string[] = []
  const expires = vi.fn()
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const headers = new Headers(init?.headers)
    if (url.pathname === '/static/test.png') {
      expect(headers.has('Blade-Auth')).toBe(false)
      expect(headers.has('Authorization')).toBe(false)
      if (failure === 'public-401') return new Response('', { status: 401 })
      return new Response(failure === 'wrong-bytes' ? 'wrong-image-bytes' : Uint8Array.from(fixturePng), { headers: { 'Content-Type': 'image/png' } })
    }
    expect(headers.get('Blade-Auth')).toBe('bearer fixture-token')
    const category = categories.response(url, init?.method)
    if (category !== undefined) return Response.json({ data: category })
    if (url.pathname.endsWith('/searchByKeyword')) return Response.json({ data: { records: uploaded.has(url.searchParams.get('id') ?? '') || failure !== undefined ? [{ name: `g1brain-${image.key}.png`,
      path: failure === 'cross-origin' ? '//other.invalid/image.png' : '/static/test.png' }] : [] } })
    if (url.pathname.endsWith('/res/upload')) {
      expect(url.searchParams.get('userId')).toBe('user-123')
      if (!(init?.body instanceof FormData)) throw new Error('Expected image form')
      const categoryId = init.body.get('id')
      if (typeof categoryId !== 'string') throw new Error('Project category missing')
      expect(categories.nodes.find(node => node.id === categoryId)?.parentId).toBe('100')
      expect(categoryId).not.toBe('11')
      expect(init.body.get('fileType')).toBe('picture')
      const file = init.body.get('files')
      if (!(file instanceof File)) throw new Error('Expected static image file')
      expect(Buffer.from(await file.arrayBuffer())).toEqual(fixturePng)
      uploaded.add(categoryId)
      uploadCategories.push(categoryId)
      return Response.json({ code: 200, data: true })
    }
    if (url.pathname.endsWith('/mds')) {
      if (!(init?.body instanceof FormData)) throw new Error('Expected document form')
      const file = init.body.get('file')
      if (!(file instanceof File)) throw new Error('Expected Markdown file')
      documents.push(await file.text())
      return Response.json({ data: { id: documents.length } })
    }
    throw new Error(`Unexpected request path: ${url.pathname}`)
  })
  const client = createG1BrainClient({ baseUrl: 'http://localhost', authMode: 'oauth', clientId: 'fixture', clientSecret: 'fixture-secret',
    tenantId: '000000', publicKey: '', timeoutMs: 1000, localUserId: '', localClientId: '', onAuthExpired: expires }, fetcher)
  client.setTokens({ accessToken: 'fixture-token', tenantId: '000000', userId: 'user-123', issuedAt: Date.now() })
  return { client, fetcher, documents, expires, categories, uploadCategories }
}

describe('G1brain image-preserving document ingestion', () => {
  it('retains Word image order and alt text while deduplicating the embedded bytes', async () => {
    const document = await extractMaterialDocument(imageDocx(), '.docx', limit, limit)
    expect(document.images).toHaveLength(1)
    expect(document.images[0]?.bytes).toEqual(fixturePng)
    expect(document.markdown).toContain('工艺示意图')
    expect(document.markdown.split(image.placeholder)).toHaveLength(3)
    expect(document.markdown.indexOf('中文正文')).toBeLessThan(document.markdown.indexOf(image.placeholder))
    expect(document.markdown.indexOf(image.placeholder)).toBeLessThan(document.markdown.indexOf('一号炉'))
  })

  it('preserves XLSX pictures and emits image notes even when the worksheet data routes to a table', () => {
    const plan = planExcel(imageWorkbook(tableWorkbook()), '.xlsx', limit)
    expect(plan.tableBytes).toBeDefined()
    expect(plan.images[0]?.bytes).toEqual(fixturePng)
    expect(plan.documentText).toContain(image.placeholder)
    expect(plan.documentText).toContain('工作表图片')
    expect(plan.documentText).not.toContain('9007199254740993')
  })

  it('does not classify an image-only worksheet as empty', () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, {}, '图片说明')
    const source: unknown = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
    if (!Buffer.isBuffer(source)) throw new Error('Expected workbook bytes')
    const plan = planExcel(imageWorkbook(source), '.xlsx', limit)
    expect(plan.sheets[0]?.route).toBe('document')
    expect(plan.documentText).toContain(image.placeholder)
  })

  it('matches XML-escaped worksheet names and encoded image part names', () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, {}, '工艺 & 说明')
    const source: unknown = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
    if (!Buffer.isBuffer(source)) throw new Error('Expected workbook bytes')
    const parts = unzipSync(imageWorkbook(source))
    const relationName = 'xl/drawings/_rels/drawing1.xml.rels'
    const relation = parts[relationName]
    const picture = parts['xl/media/test.png']
    if (!relation || !picture) throw new Error('Fixture image parts missing')
    parts[relationName] = strToU8(strFromU8(relation).replace('../media/test.png', '../media/test%20picture.png'))
    delete parts['xl/media/test.png']
    parts['xl/media/test picture.png'] = picture
    const plan = planExcel(Buffer.from(zipSync(parts)), '.xlsx', limit)
    expect(plan.documentText).toContain('工艺 & 说明')
    expect(plan.images).toHaveLength(1)
  })

  it('rejects external Office image relationships without fetching them', async () => {
    const parts = unzipSync(imageWorkbook())
    const name = 'xl/drawings/_rels/drawing1.xml.rels'
    const rel = parts[name]
    if (!rel) throw new Error('Fixture relation missing')
    parts[name] = strToU8(strFromU8(rel).replace('Target="../media/test.png"', 'TargetMode="External" Target="https://example.invalid/private.png"'))
    await expect(extractMaterialDocument(Buffer.from(zipSync(parts)), '.xlsx', limit, limit)).rejects.toThrow('外部图片')
  })

  it('resolves Markdown reference images without reading code examples or ordinary links', async () => {
    const load = vi.fn(async () => fixturePng)
    const source = '![说明][pic]\n\n[pic]: images/test.png "标题"\n\n[文档](secret.txt)\n\n```md\n![示例](not-read.png)\n```'
    const document = await markdownImages(source, load, limit)
    expect(load).toHaveBeenCalledExactlyOnceWith('images/test.png')
    expect(document.markdown).toContain(`![说明](<${image.placeholder}> "标题")`)
    expect(document.markdown).toContain('![示例](not-read.png)')
  })

  it('retains existing HTTP image references without fetching them and rejects active/local schemes', async () => {
    const load = vi.fn(async () => fixturePng)
    expect((await markdownImages('![远程](https://example.com/a.png)', load, limit)).images).toEqual([])
    await expect(markdownImages('![危险](file:///secret.png)', load, limit)).rejects.toThrow('相对路径')
    await expect(markdownImages('<img src="secret.png">', load, limit)).rejects.toThrow('HTML 图片')
    expect(load).not.toHaveBeenCalled()
  })

  it('preflights all local references and confines them to the selected materials directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'g1brain-image-scope-'))
    roots.push(root)
    await mkdir(join(root, 'notes'))
    await writeFile(join(root, 'test.png'), fixturePng)
    await writeFile(join(root, 'notes', 'valid.md'), '![说明](../test.png)')
    await writeFile(join(root, 'notes', 'missing.md'), '![缺失](not-found.png)')
    await writeFile(join(root, 'notes', 'escape.md'), '![越界](../../secret.png)')
    const scope = await openWorkspaceScope(root)
    expect((await scope.prepareUploads(['notes/valid.md']))[0]?.images).toHaveLength(1)
    const { client, fetcher } = backend()
    const uploader = createG1BrainTools({ scope, client }).find(tool => tool.name === 'g1brain_upload_selected_files')!
    expect((await uploader.execute({ collectionName: 'library', files: ['notes/valid.md', 'notes/missing.md'] })).isError).toBe(true)
    expect(fetcher).not.toHaveBeenCalled()
    await expect(scope.prepareUploads(['notes/escape.md'])).rejects.toThrow('超出')
  })

  it.skipIf(process.platform === 'win32')('rejects image symlinks that leave the materials directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'g1brain-image-link-'))
    const outside = await mkdtemp(join(tmpdir(), 'g1brain-image-outside-'))
    roots.push(root, outside)
    await writeFile(join(outside, 'secret.png'), fixturePng)
    await symlink(join(outside, 'secret.png'), join(root, 'image.png'))
    await writeFile(join(root, 'doc.md'), '![图片](image.png)')
    await expect((await openWorkspaceScope(root)).prepareUploads(['doc.md'])).rejects.toThrow('超出')
  })

  it('uploads only image bytes first, rewrites Markdown and reuses verified same-name resources', async () => {
    const { client, fetcher, documents } = backend()
    const document = await extractMaterialDocument(imageDocx(), '.docx', limit, limit)
    await client.uploadMdMaterial('library', 'example.docx.md', document)
    await client.uploadMdMaterial('library', 'example.docx.md', document)
    expect(documents).toHaveLength(2)
    expect(documents[0]).toContain('http://localhost/static/test.png')
    expect(documents[0]).not.toContain('g1brain-image:')
    expect(documents[0]).not.toContain('fixture-token')
    expect(fetcher.mock.calls.filter(([url]) => new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).pathname.endsWith('/res/upload'))).toHaveLength(1)
  })

  it('does not submit Markdown after an image upload fails, or retry an uncertain image POST', async () => {
    const { client, fetcher, documents } = backend()
    const original = fetcher.getMockImplementation()!
    fetcher.mockImplementation(async (url, init) => requestUrl(url).pathname.endsWith('/res/upload')
      ? Response.json({ code: 500 }, { status: 500 }) : original(url, init))
    const document = { markdown: `![](${image.placeholder})`, images: [image] }
    await expect(client.uploadMdMaterial('library', 'doc.md', document)).rejects.toThrow()
    await expect(client.uploadMdMaterial('library', 'doc.md', document)).rejects.toThrow('结果不确定')
    expect(fetcher.mock.calls.filter(([url, init]) => requestUrl(url).pathname.endsWith('/res/upload') && init?.method === 'POST')).toHaveLength(1)
    expect(documents).toEqual([])
  })

  it('deduplicates pictures inside a project rather than reusing another project\'s category record', async () => {
    const { client, uploadCategories, categories } = backend()
    const document = { markdown: `![](${image.placeholder})`, images: [image] }
    const project = { kind: 'ontology' as const, collectionName: 'collection', domainName: 'first', displayName: '同名项目' }
    await client.uploadMdMaterial('library', 'a.md', document, undefined, project)
    await client.uploadMdMaterial('library', 'b.md', document, undefined, { ...project, domainName: 'second' })
    await client.uploadMdMaterial('library', 'c.md', document, undefined, project)
    expect(uploadCategories).toEqual(['101', '102'])
    expect(categories.nodes.filter(node => node.parentId === '100')).toHaveLength(2)
  })

  it('does not upload images or Markdown if the project category cannot be created', async () => {
    const { client, fetcher, documents } = backend()
    const original = fetcher.getMockImplementation()!
    fetcher.mockImplementation(async (url, init) => requestUrl(url).pathname.endsWith('/category/add')
      ? Response.json({ code: 403 }, { status: 403 }) : original(url, init))
    await expect(client.uploadMdMaterial('library', 'doc.md', { markdown: `![](${image.placeholder})`, images: [image] })).rejects.toThrow()
    expect(documents).toEqual([])
    expect(fetcher.mock.calls.some(([url]) => requestUrl(url).pathname.endsWith('/res/upload'))).toBe(false)
  })

  it.each(['public-401', 'wrong-bytes', 'cross-origin'] as const)('rejects unusable static images without expiring valid login: %s', async (failure) => {
    const { client, fetcher, expires, documents } = backend(failure)
    await expect(client.uploadMdMaterial('library', 'doc.md', { markdown: `![](${image.placeholder})`, images: [image] })).rejects.toThrow()
    expect(expires).not.toHaveBeenCalled()
    expect(client.authState).toBeDefined()
    expect(documents).toEqual([])
    expect(fetcher.mock.calls.filter(([url]) => requestUrl(url).pathname === '/static/test.png')).toHaveLength(failure === 'cross-origin' ? 0 : 1)
  })

  it.each([401, '401'])('clears authentication and notifies once on business rejection %s', async (code) => {
    const { client, fetcher, expires, documents } = backend()
    fetcher.mockResolvedValue(Response.json({ code, msg: '登录超时' }))
    await expect(client.listMdDocuments('library')).rejects.toThrow('重新登录')
    await expect(client.listMdDocuments('library')).rejects.toThrow('重新登录')
    expect(client.authState).toBeUndefined()
    expect(expires).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(documents).toEqual([])
  })

  it('rejects image payloads and unsupported types before sending a request', async () => {
    expect(() => materialImage(Buffer.from('<svg/>'))).toThrow('图片格式')
    await expect(extractMaterialDocument(imageDocx(), '.docx', 10, limit)).rejects.toThrow()
    const { client, fetcher } = backend()
    client.clearTokens()
    await expect(client.uploadMdMaterial('library', 'doc.md', { markdown: '', images: [image] })).rejects.toThrow('真实登录')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('leaves source image and Word bytes unchanged throughout extraction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'g1brain-image-source-'))
    roots.push(root)
    const word = imageDocx()
    await writeFile(join(root, 'source.docx'), word)
    await (await openWorkspaceScope(root)).prepareUploads(['source.docx'])
    expect(await readFile(join(root, 'source.docx'))).toEqual(word)
  })
})
