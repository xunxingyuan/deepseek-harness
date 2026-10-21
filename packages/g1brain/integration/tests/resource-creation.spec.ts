import { describe, expect, it, vi } from 'vitest'
import { createG1BrainClient } from '../src/legacy/g1brain/client.ts'
import { createG1BrainTools } from '../src/legacy/bridge/tools.ts'
import { assertTaskScope } from '../src/legacy/bridge/policy.ts'
import { resourceName } from '../src/names.ts'

function jsonBody(value: RequestInit['body']): unknown {
  if (typeof value !== 'string') throw new Error('Expected JSON request text')
  const parsed: unknown = JSON.parse(value)
  return parsed
}

function requestUrl(value: string | URL | Request): string {
  return typeof value === 'string' ? value : value instanceof URL ? value.href : value.url
}

function fixture() {
  const fetcher = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => Response.json({ data: {} }))
  const client = createG1BrainClient({ baseUrl: 'http://localhost', authMode: 'local-dev', clientId: 'test', clientSecret: '',
    tenantId: '000000', publicKey: '', timeoutMs: 1000, localUserId: 'developer', localClientId: 'g1brain-web' }, fetcher)
  return { fetcher, client }
}

describe('G1brain resource creation and labels', () => {
  it('resolves standalone Chinese collection names and persists the display name instead of using it as an API key', async () => {
    const { client, fetcher } = fixture()
    fetcher.mockImplementation(async (_url, options) => Response.json({ data: jsonBody(options?.body) }))
    const tool = createG1BrainTools({ client }).find(tool => tool.name === 'g1brain_create_ontology_collection')!
    const result = await tool.execute({ name: '生产 周报/本体' })
    expect(result.isError).not.toBe(true)
    const expected = resourceName('生产 周报/本体', 'col')
    expect(jsonBody(fetcher.mock.calls[0]?.[1]?.body)).toMatchObject({ name: expected, attributes: { displayName: '生产 周报/本体' } })
    expect(result.structuredContent).toMatchObject({ name: expected, displayName: '生产 周报/本体' })
  })

  it('stores a domain label through config PATCH and verifies it on readback', async () => {
    const { client, fetcher } = fixture()
    fetcher.mockImplementation(async () => Response.json({ data: { displayName: '生产领域' } }))
    await client.createOntologyDomain('existing_collection', 'dom_weekly', '生产领域')
    expect(fetcher.mock.calls.map(([url, options]) => [requestUrl(url), options?.method ?? 'GET'])).toEqual([
      ['http://localhost/kgApi/v1/gs/collections/existing_collection/domains', 'POST'],
      ['http://localhost/kgApi/v1/gs/collections/existing_collection/domains/dom_weekly/config', 'PATCH'],
      ['http://localhost/kgApi/v1/gs/collections/existing_collection/domains/dom_weekly/config', 'GET'],
    ])
    expect(jsonBody(fetcher.mock.calls[0]?.[1]?.body)).toEqual({ name: 'dom_weekly' })
    expect(jsonBody(fetcher.mock.calls[1]?.[1]?.body)).toEqual({ displayName: '生产领域' })
  })

  it('does not claim success when display-name storage fails or the returned collection key differs', async () => {
    const { client, fetcher } = fixture()
    await expect(client.createOntologyDomain('collection', 'dom_test', '领域')).rejects.toThrow('could not be verified')
    fetcher.mockResolvedValue(Response.json({ data: { name: 'unexpected_collection' } }))
    await expect(client.createOntologyCollection('col_test', '', '本体')).rejects.toThrow('different collection API name')
  })

  it('does not silently convert an unsafe identifier from an already bound legacy Session', async () => {
    const { client, fetcher } = fixture()
    const tools = createG1BrainTools({ client, task: { mode: 'new-ontology', folderPath: '/tmp', instruction: '', createOntologyCollectionName: '旧中文本体' } })
    const result = await tools.find(tool => tool.name === 'g1brain_create_ontology_collection')!.execute({ name: '旧中文本体' })
    expect(result.isError).toBe(true)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['_schema', '_shared', 'schema', 'share'])('refuses direct writes to reserved domain %s even without a bound task', (domainName) => {
    expect(() => { assertTaskScope(undefined, 'g1brain_create_ontology_entity', { domainName }) }).toThrow('系统领域')
  })
})
