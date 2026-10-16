/** Real Loader workflow against a loopback G1brain backend with an isolated materials directory. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import type G1brainIntegration from '@deepseek-ai/dsh-g1brain-integration'
import { bootProductionProfile } from '../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'
import { chineseDocx, chineseWorkbook } from './materials.ts'

const overlay = process.argv[2]
if (!overlay) throw new Error('G1brain workflow driver requires a patch path')
const requests: string[] = []
const failures: string[] = []
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (request.headers['x-user-id'] !== 'developer' || request.headers['x-client-id'] !== 'g1brain-web') {
      throw new Error('Development request identity missing')
    }
    request.setEncoding('utf8')
    let body = ''
    for await (const chunk of request) body += String(chunk)
    let name: string | undefined
    if (request.method === 'POST' && url.pathname === '/kgApi/v1/gs/collections') {
      const input: unknown = JSON.parse(body)
      if (typeof input !== 'object' || input === null || !('name' in input) || input.name !== '周报本体') throw new Error('Unexpected collection')
      requests.push('collection:周报本体'); name = input.name
    } else if (request.method === 'POST' && decodeURIComponent(url.pathname) === '/kgApi/v1/gs/collections/周报本体/domains') {
      const input: unknown = JSON.parse(body)
      if (typeof input !== 'object' || input === null || !('name' in input) || input.name !== '周报领域' || !requests.includes('collection:周报本体')) throw new Error('Unexpected domain')
      requests.push('domain:周报领域'); name = input.name
    } else if (request.method === 'POST' && url.pathname === '/mdApi/v1/md/collections') {
      if (url.searchParams.get('name') !== '周报文档库') throw new Error('Unexpected document library')
      requests.push('library:周报文档库'); name = '周报文档库'
    } else if (request.method === 'POST' && decodeURIComponent(url.pathname) === '/mdApi/v1/md/collections/周报文档库/mds') {
      const form = await new Response(body, { headers: { 'Content-Type': request.headers['content-type'] ?? '' } }).formData()
      const file = form.get('file')
      if (!(file instanceof File)) throw new Error('Expected UTF-8 Markdown file')
      const content = await file.text()
      const expected = file.name === '中文 Word.docx.md' ? '生产周报：中文正文' : '二号炉例行检查'
      if (!['中文 Word.docx.md', '中文 Excel.xlsx.md'].includes(file.name) || !content.includes(expected)
        || content.includes('\ufffd') || content.startsWith('PK')) throw new Error('Office upload was not extracted into Chinese Markdown')
      requests.push(`upload:${file.name}`)
    } else if (request.method === 'DELETE' && decodeURIComponent(url.pathname) === '/kgApi/v1/gs/collections/周报本体/domains/周报领域/props/obsolete-property') {
      if (url.searchParams.get('cascade') !== 'false' || !requests.includes('domain:周报领域')) throw new Error('Unexpected deletion')
      requests.push('delete:obsolete-property')
    } else throw new Error(`Unexpected request ${request.method} ${url.pathname}`)
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ code: 200, data: { name } }))
  })().catch((error: unknown) => {
    failures.push(error instanceof Error ? error.message : String(error))
    response.writeHead(500, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ code: 500 }))
  })
})
let ctx: Context | undefined
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture server has no TCP address')
  process.env.G1BRAIN_TEST_BASE_URL = `http://127.0.0.1:${address.port}`
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
  ctx = await bootProductionProfile({ binName: 'g1brain-workflow-test', profile: 'headless', overlayPaths: [overlay] })
  const id = SessionId('session-g1brain-workflow')
  const { agent } = await ctx.agents.create({ sessionId: id, meta: { cwd: materials }, agentOptions: { provider: 'g1brain-workflow-fixture', model: 'fixture' } })
  const before = ctx.tools.schemas(agent).filter(tool => tool.name.startsWith('g1brain_')).length
  const service = ctx.get('g1brain') as G1brainIntegration
  await service.bindSession({ sessionId: id, target: { mode: 'new-ontology', folderPath: materials,
    createOntologyCollectionName: '周报本体', createDomainName: '周报领域', createDocumentLibraryName: '周报文档库' } })
  const after = ctx.tools.schemas(agent).filter(tool => tool.name.startsWith('g1brain_')).length
  const result = await runFixtureTurn(ctx, { task: '请读取第一张表并创建周报本体、领域和文档库，随后申请删除废弃属性，用中文回复。' })
  if (failures.length) throw new Error(failures.join('; '))
  await writeFile(join(process.cwd(), 'backend-proof.json'), JSON.stringify({ requests, before, after, output: result.output }))
  process.stdout.write(JSON.stringify({ type: 'g1brain-workflow-result', before, after, output: result.output }) + '\n')
} finally {
  await ctx?.fiber.dispose()
  await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
}
