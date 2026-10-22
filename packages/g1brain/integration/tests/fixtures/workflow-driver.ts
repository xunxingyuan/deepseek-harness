/** Real Loader workflow against a loopback G1brain backend with an isolated materials directory. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire, registerHooks } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import type G1brainIntegration from '@deepseek-ai/dsh-g1brain-integration'
import { bootProductionProfile } from '../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'
import { chineseDocx, chineseWorkbook } from './materials.ts'
import { tableWorkbook, workbookCell } from './table-workbooks.ts'
import { Buffer } from 'node:buffer'
import * as XLSX from 'xlsx'

const overlay = process.argv[2]
if (!overlay) throw new Error('G1brain workflow driver requires a patch path')
const requests: string[] = []
const failures: string[] = []
const tableMode = process.env.G1BRAIN_TEST_TABLES === '1'
const tableCollections: Array<{ id: string; name: string; description: string }> = []
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const tableRequest = tableMode && (url.pathname.startsWith('/api/') || url.pathname === '/mcp/')
    if (!tableRequest && (request.headers['x-user-id'] !== 'developer' || request.headers['x-client-id'] !== 'g1brain-web')) {
      throw new Error('Development request identity missing')
    }
    if (tableRequest && request.headers['x-user-id']) throw new Error('G1brain identity leaked to the table service')
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Expected binary request bytes')
      chunks.push(chunk)
    }
    const bytes = Buffer.concat(chunks)
    const body = bytes.toString('utf8')
    if (tableRequest) {
      let result: unknown
      if (url.pathname === '/api/collections') {
        if (request.method === 'POST') {
          const input: unknown = JSON.parse(body)
          if (typeof input !== 'object' || input === null || !('name' in input) || input.name !== '周报领域'
            || !('description' in input) || typeof input.description !== 'string') throw new Error('Wrong table domain label')
          tableCollections.push({ id: 'table-test', name: input.name, description: input.description })
          requests.push('table-collection:周报领域')
          result = tableCollections[0]
        } else result = tableCollections
      } else if (url.pathname === '/api/uploads') {
        const form = await new Response(bytes, { headers: { 'Content-Type': request.headers['content-type'] ?? '' } }).formData()
        const file = form.get('files')
        if (!(file instanceof File) || form.get('collection_ids') !== 'table-test') throw new Error('Wrong table upload scope')
        const workbook = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: 'buffer' })
        if (workbook.SheetNames.join() !== '生产数据' || workbookCell(workbook, '生产数据', 'C2')?.v !== '9007199254740993') throw new Error('Excel split or precision lost')
        requests.push('table-upload:生产数据')
        result = { job_ids: ['job-test'] }
      } else if (url.pathname === '/api/jobs') {
        result = [{ id: 'job-test', filename: 'mixed.xlsx', status: 'completed', detail: '', collection_ids: ['table-test'], datasets: ['data-test'], sheets: [] }]
      } else if (url.pathname === '/mcp/') {
        const input = JSON.parse(body) as {
          id?: number
          method: string
          params?: { name?: string; arguments?: { collection_ids?: string[] } }
        }
        if (input.method === 'notifications/initialized') { response.writeHead(202); response.end(); return }
        if (input.method === 'initialize') result = { jsonrpc: '2.0', id: input.id, result: { protocolVersion: '2025-03-26' } }
        else {
          if (url.searchParams.get('collection_id') !== 'table-test' || input.params?.arguments?.collection_ids?.join() !== 'table-test') throw new Error('Unscoped table read')
          requests.push(`table-read:${input.params.name}`)
          const value = input.params.name === 'query_tables' ? { rows: [{ total: '215' }] }
            : { tables: [{ dataset_id: 'data-test', table_name: 'data_test', columns: [{ name: 'output' }] }] }
          result = { jsonrpc: '2.0', id: input.id, result: { structuredContent: value } }
        }
      } else throw new Error(`Unexpected table path ${url.pathname}`)
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(result)); return
    }
    let name: string | undefined
    let data: unknown
    if (request.method === 'POST' && url.pathname === '/kgApi/v1/gs/collections') {
      const input: unknown = JSON.parse(body)
      if (typeof input !== 'object' || input === null || !('name' in input) || input.name !== 'col_7c120e3057d72928f5491e86') throw new Error('Unexpected collection')
      requests.push('collection:col_7c120e3057d72928f5491e86'); name = input.name
      if (!('attributes' in input) || JSON.stringify(input.attributes) !== JSON.stringify({ displayName: '周报本体' })) throw new Error('Collection display name missing')
      data = input
    } else if (request.method === 'POST' && decodeURIComponent(url.pathname) === '/kgApi/v1/gs/collections/col_7c120e3057d72928f5491e86/domains') {
      const input: unknown = JSON.parse(body)
      if (typeof input !== 'object' || input === null || !('name' in input) || input.name !== 'dom_e4d35bcec9eb3d594c4bdeb7' || !requests.includes('collection:col_7c120e3057d72928f5491e86')) throw new Error('Unexpected domain')
      requests.push('domain:dom_e4d35bcec9eb3d594c4bdeb7'); name = input.name
    } else if (url.pathname === '/kgApi/v1/gs/collections/col_7c120e3057d72928f5491e86/domains/dom_e4d35bcec9eb3d594c4bdeb7/config') {
      if (request.method === 'PATCH') {
        if (JSON.stringify(JSON.parse(body)) !== JSON.stringify({ displayName: '周报领域' })) throw new Error('Domain display name missing')
        requests.push('domain-display:周报领域')
      } else if (request.method !== 'GET') throw new Error('Unexpected config method')
      data = { displayName: '周报领域' }
    } else if (request.method === 'POST' && url.pathname === '/mdApi/v1/md/collections') {
      if (url.searchParams.get('name') !== '周报文档库') throw new Error('Unexpected document library')
      requests.push('library:周报文档库'); name = '周报文档库'
    } else if (request.method === 'POST' && decodeURIComponent(url.pathname) === '/mdApi/v1/md/collections/周报文档库/mds') {
      const form = await new Response(body, { headers: { 'Content-Type': request.headers['content-type'] ?? '' } }).formData()
      const file = form.get('file')
      if (!(file instanceof File)) throw new Error('Expected UTF-8 Markdown file')
      const content = await file.text()
      const expected = file.name === '中文 Word.docx.md' ? '生产周报：中文正文' : file.name === '混合数据.xlsx.notes.md' ? '这是说明正文' : '二号炉例行检查'
      if (!['中文 Word.docx.md', '中文 Excel.xlsx.md', '混合数据.xlsx.notes.md'].includes(file.name) || !content.includes(expected)
        || content.includes('\ufffd') || content.startsWith('PK')) throw new Error('Office upload was not extracted into Chinese Markdown')
      if (file.name === '混合数据.xlsx.notes.md' && content.includes('9007199254740993')) throw new Error('Data sheet leaked to vector library')
      requests.push(`upload:${file.name}`)
    } else if (request.method === 'DELETE' && decodeURIComponent(url.pathname) === '/kgApi/v1/gs/collections/col_7c120e3057d72928f5491e86/domains/dom_e4d35bcec9eb3d594c4bdeb7/props/obsolete-property') {
      if (url.searchParams.get('cascade') !== 'false' || !requests.includes('domain:dom_e4d35bcec9eb3d594c4bdeb7')) throw new Error('Unexpected deletion')
      requests.push('delete:obsolete-property')
    } else throw new Error(`Unexpected request ${request.method} ${url.pathname}`)
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ code: 200, data: data ?? { name } }))
  })().catch((error: unknown) => {
    failures.push(error instanceof Error ? error.message : String(error))
    response.writeHead(500, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ code: 500 }))
  })
})
let ctx: Context | undefined
let resolutionGuard: ReturnType<typeof registerHooks> | undefined
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture server has no TCP address')
  process.env.G1BRAIN_TEST_BASE_URL = `http://127.0.0.1:${address.port}`
  if (tableMode) process.env.G1BRAIN_TEST_TABLE_URL = process.env.G1BRAIN_TEST_BASE_URL
  else Reflect.deleteProperty(process.env, 'G1BRAIN_TEST_TABLE_URL')
  process.env.G1BRAIN_AUTH_MODE = 'local-dev'
  process.env.G1BRAIN_ALLOW_LOCAL_DEV = '1'
  process.env.G1BRAIN_ALLOW_DEV_WRITES = '1'
  process.env.G1BRAIN_LOCAL_USER_ID = 'developer'
  process.env.G1BRAIN_LOCAL_CLIENT_ID = 'g1brain-web'
  const materials = join(process.cwd(), '中文 周报材料')
  await mkdir(materials)
  await writeFile(join(materials, '第一张表.md'), '# 第一张表\nG1BRAIN_WINDOWS_MATERIAL_EVIDENCE\n')
  await writeFile(join(materials, '中文 Word.docx'), chineseDocx())
  await writeFile(join(materials, '中文 Excel.xlsx'), chineseWorkbook())
  if (tableMode) await writeFile(join(materials, '混合数据.xlsx'), tableWorkbook())
  // Built plugins must work without the source checkout's build-only spreadsheet dependency.
  if (process.env.DSH_EXAMPLE_MODE === 'lib') {
    const bundle = await readFile(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-g1brain-integration'), 'utf8')
    if (!bundle.startsWith('//! Bundled SheetJS license notices') || !bundle.includes('Apache License')) {
      throw new Error('Installed G1brain must retain bundled SheetJS notices')
    }
    resolutionGuard = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === 'xlsx' || specifier.startsWith('xlsx/')) throw new Error('Installed G1brain must embed SheetJS, not resolve xlsx')
        return nextResolve(specifier, context)
      },
    })
  }
  ctx = await bootProductionProfile({ binName: 'g1brain-workflow-test', profile: 'headless', overlayPaths: [overlay] })
  const id = SessionId('session-g1brain-workflow')
  const { agent } = await ctx.agents.create({ sessionId: id, meta: { cwd: materials }, agentOptions: { provider: 'g1brain-workflow-fixture', model: 'fixture' } })
  const before = ctx.tools.schemas(agent).filter(tool => tool.name.startsWith('g1brain_')).length
  const service = ctx.get('g1brain') as G1brainIntegration
  await service.bindSession({ sessionId: id, target: { mode: 'new-ontology', folderPath: materials,
    createOntologyCollectionName: '周报本体', createOntologyCollectionDisplayName: '周报本体',
    createDomainName: '周报领域', createDomainDisplayName: '周报领域', createDocumentLibraryName: '周报文档库' } })
  const after = ctx.tools.schemas(agent).filter(tool => tool.name.startsWith('g1brain_')).length
  const result = await runFixtureTurn(ctx, { task: '请读取第一张表并创建col_7c120e3057d72928f5491e86、领域和文档库，随后申请删除废弃属性，用中文回复。' })
  if (failures.length) throw new Error(failures.join('; '))
  await writeFile(join(process.cwd(), 'backend-proof.json'), JSON.stringify({ requests, before, after, output: result.output }))
  process.stdout.write(JSON.stringify({ type: 'g1brain-workflow-result', before, after, output: result.output }) + '\n')
} finally {
  try { await ctx?.fiber.dispose() } finally {
    resolutionGuard?.deregister()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  }
}
