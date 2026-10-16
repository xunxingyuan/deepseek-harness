import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Buffer } from 'node:buffer'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import G1brainIntegration from '../src/index.ts'

const contexts: Context[] = []
const ENV_NAMES = ['G1BRAIN_AUTH_MODE', 'G1BRAIN_ACCESS_TOKEN', 'G1BRAIN_CLIENT_SECRET', 'G1BRAIN_CLIENT_ID', 'G1BRAIN_LOCAL_USER_ID', 'G1BRAIN_LOCAL_CLIENT_ID', 'G1BRAIN_ALLOW_LOCAL_DEV'] as const
const previousEnv = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]))

function clearAuthentication(): void {
  for (const name of ENV_NAMES) Reflect.deleteProperty(process.env, name)
}

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const name of ENV_NAMES) {
    const value = previousEnv[name]
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

async function integration(baseUrl: string): Promise<{ ctx: Context; service: G1brainIntegration }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide('sessions', { get: () => undefined } as never)
  ctx.provide('agents', { get: () => undefined, list: () => [] } as never)
  ctx.provide('approval', { request: async () => 'rejected' } as never)
  await ctx.plugin(G1brainIntegration, { baseUrl, clientId: 'client', tenantId: '000000', timeoutMs: 15000 })
  return { ctx, service: ctx.get('g1brain') as G1brainIntegration }
}

describe('G1brain desktop integration', () => {
  it('stays enabled without treating development sign-in as API authorization', async () => {
    clearAuthentication()
    process.env.G1BRAIN_LOCAL_USER_ID = 'developer'
    process.env.G1BRAIN_LOCAL_CLIENT_ID = 'g1brain-web'
    const { ctx, service } = await integration('http://127.0.0.1:18203/')
    expect(service.status()).toEqual({ configured: false, mode: 'local-dev' })
    expect(ctx.tools.schemas().map(tool => tool.name).filter(name => name.startsWith('g1brain_'))).toEqual([])
    await expect(service.listOntologyCollections()).rejects.toThrow('not configured')
  })

  it('reads and normalizes catalogs with explicit local-development headers', async () => {
    clearAuthentication()
    process.env.G1BRAIN_ALLOW_LOCAL_DEV = '1'
    process.env.G1BRAIN_LOCAL_USER_ID = 'developer'
    process.env.G1BRAIN_LOCAL_CLIENT_ID = 'g1brain-web'
    const fetcher = vi.fn(async (url: URL, options: RequestInit) => {
      expect(options.redirect).toBe('error')
      expect(options.headers).toMatchObject({ 'X-User-Id': 'developer', 'X-Client-Id': 'g1brain-web', 'Tenant-Id': '000000' })
      return Response.json(url.pathname.includes('kgApi')
        ? { data: { records: [{ name: '制造本体', attributes: { displayName: '制造知识图谱' } }, { name: '' }, { unexpected: true }] } }
        : { data: ['资料库'] })
    })
    vi.stubGlobal('fetch', fetcher)
    const { ctx, service } = await integration('http://127.0.0.1:18203/')
    expect(service.status()).toEqual({ configured: true, mode: 'local-dev' })
    const globalTools = ctx.tools.schemas().map(tool => tool.name).filter(name => name.startsWith('g1brain_'))
    expect(globalTools).toHaveLength(16)
    expect(globalTools).toContain('g1brain_list_ontology_collections')
    expect(globalTools).toContain('g1brain_list_document_libraries')
    expect(globalTools).toContain('g1brain_list_ontology_domains')
    expect(globalTools).toContain('g1brain_hybrid_search')
    expect(globalTools).not.toContain('g1brain_create_ontology_entity')
    expect(await service.listOntologyCollections()).toEqual([{ name: '制造本体', displayName: '制造知识图谱' }])
    expect(await service.listDocumentLibraries()).toEqual([{ name: '资料库' }])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('reads domain display metadata without changing canonical names', async () => {
    clearAuthentication()
    process.env.G1BRAIN_ALLOW_LOCAL_DEV = '1'
    process.env.G1BRAIN_LOCAL_USER_ID = 'developer'
    process.env.G1BRAIN_LOCAL_CLIENT_ID = 'g1brain-web'
    const fetcher = vi.fn(async (_url: URL) => Response.json({ data: [
      { name: '设备领域', extra: { displayName: '设备运维领域' } }, { name: '_schema' },
    ] }))
    vi.stubGlobal('fetch', fetcher)
    const { service } = await integration('http://127.0.0.1:18203/')
    expect(await service.listOntologyDomains('已有本体')).toEqual([
      { name: '设备领域', displayName: '设备运维领域' }, { name: '_schema' },
    ])
    expect(fetcher.mock.calls[0]?.[0].href).toContain('/domains?view=detail')
  })

  it('explains read-only Sessions and user-language replies, and removes that guidance when unloaded', async () => {
    clearAuthentication()
    process.env.G1BRAIN_ALLOW_LOCAL_DEV = '1'
    process.env.G1BRAIN_LOCAL_USER_ID = 'developer'
    process.env.G1BRAIN_LOCAL_CLIENT_ID = 'g1brain-web'
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('sessions', { get: () => undefined } as never)
    ctx.provide('agents', { get: () => undefined, list: () => [] } as never)
    ctx.provide('approval', { request: async () => 'rejected' } as never)
    const fiber = await ctx.plugin(G1brainIntegration, { baseUrl: 'http://127.0.0.1:18203/', clientId: 'client', tenantId: '000000', timeoutMs: 15000 })
    const section = (await ctx.systemPrompt.assemble()).sections.find(item => item.name === 'g1brain:workflow')
    expect(section?.text).toContain('Use Simplified Chinese for Chinese requests')
    expect(section?.text).toContain('Ordinary Sessions provide discovery and search')
    expect(section?.text).toContain('Do not interpret missing write tools as missing API credentials')
    expect(section?.text).toContain('without asking for extra confirmation')
    expect(section?.text).toContain('not a raw text read of Office bytes')
    expect(section?.text).toContain('not the ontology collection name or a display name')
    expect(section?.text).toContain('A request only for information or a plan is not a request to write data')
    expect(section?.text).toContain('Deletion and replacement imports')
    expect(section?.text).not.toContain('after the user approves the plan')
    await fiber.dispose()
    expect((await ctx.systemPrompt.assemble()).sections.some(item => item.name === 'g1brain:workflow')).toBe(false)
  })

  it('rejects invalid catalog responses', async () => {
    clearAuthentication()
    process.env.G1BRAIN_ALLOW_LOCAL_DEV = '1'
    process.env.G1BRAIN_LOCAL_USER_ID = 'developer'
    process.env.G1BRAIN_LOCAL_CLIENT_ID = 'g1brain-web'
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: { wrong: [] } })))
    const { service } = await integration('http://127.0.0.1:18203/')
    await expect(service.listOntologyCollections()).rejects.toThrow('invalid catalog')
  })

  it('uses the G1brain OAuth API headers when an explicit token and client secret are supplied', async () => {
    clearAuthentication()
    process.env.G1BRAIN_AUTH_MODE = 'oauth'
    process.env.G1BRAIN_CLIENT_ID = 'client'
    process.env.G1BRAIN_CLIENT_SECRET = 'test-secret'
    process.env.G1BRAIN_ACCESS_TOKEN = 'test-token'
    const fetcher = vi.fn(async (_url: URL, options: RequestInit) => {
      expect(options.headers).toMatchObject({
        Authorization: `Basic ${Buffer.from('client:test-secret').toString('base64')}`,
        'Blade-Auth': 'bearer test-token',
      })
      return Response.json({ data: [] })
    })
    vi.stubGlobal('fetch', fetcher)
    const { service } = await integration('http://127.0.0.1:18203/')
    expect(service.status()).toEqual({ configured: true, mode: 'oauth' })
    expect(await service.listOntologyCollections()).toEqual([])
  })
})
