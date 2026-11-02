import { describe, expect, it, vi } from 'vitest'
import { requireNewSid } from '../src/names.ts'
import { createG1BrainClient } from '../src/legacy/g1brain/client.ts'
import { createG1BrainTools } from '../src/legacy/bridge/tools.ts'
import { validateInput } from '../src/legacy/bridge/validate.ts'
import { toHarnessToolSchema } from '../src/tool-schema.ts'

function requestBody(value: RequestInit['body']): unknown {
  if (typeof value !== 'string') throw new Error('Expected JSON body')
  const parsed: unknown = JSON.parse(value)
  return parsed
}

function requestUrl(value: string | URL | Request | undefined): string {
  if (value === undefined) throw new Error('Expected request URL')
  return typeof value === 'string' ? value : value instanceof URL ? value.href : value.url
}

function fixture(definitions: unknown = []) {
  const fetcher = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => Response.json({ data:
    options?.method === 'POST' ? { id: '123', label: '属于单元' } : definitions }))
  const client = createG1BrainClient({ baseUrl: 'http://localhost', authMode: 'local-dev', clientId: 'test', clientSecret: '',
    tenantId: '000000', publicKey: '', timeoutMs: 1000, localUserId: 'developer', localClientId: 'g1brain-web' }, fetcher)
  return { client, fetcher, tools: createG1BrainTools({ client }) }
}

const reference = { collectionName: 'legacy.collection', domainName: 'legacy.domain' }
const edge = { fromSid: 'legacy.source-1', toSid: 'legacy.target-2', relationSid: 'legacy.belongsToUnit', properties: { evidence: '原文' } }
const definition = { kind: 'RELATION', sid: edge.relationSid, displayName: '属于单元' }

describe('G1brain new SID rules and existing references', () => {
  it.each(['Instrument', 'belongs_to_unit', 'Q0001', 'A', 'property_12'])('retains safe new SID %s', (sid) => {
    expect(requireNewSid(sid)).toBe(sid)
  })

  it.each(['dom.Instrument', 'domain/name', 'class-name', '中文', '1class', '_class', '', ' A', 'A ', 'A\n'])('rejects unsafe new SID %j', (sid) => {
    expect(() => requireNewSid(sid)).toThrow('displayName')
  })

  it.each(['g1brain_create_ontology_entity', 'g1brain_create_ontology_property', 'g1brain_create_ontology_relation_type'])('documents and rejects unsafe creation through %s', async (name) => {
    const { tools, fetcher } = fixture()
    const tool = tools.find(item => item.name === name)!
    const args = { ...reference, sid: 'dom.invalid', displayName: '中文显示名', valueType: 'STRING', kind: 'SCALAR' }
    const schemaArgs = name === 'g1brain_create_ontology_property' ? args : { ...reference, sid: args.sid, displayName: args.displayName }
    expect(() => { validateInput(tool.inputSchema, schemaArgs) }).toThrow('displayName')
    expect(JSON.stringify(toHarnessToolSchema(tool.inputSchema))).toContain('不要拼接 collection/domain 前缀')
    expect((await tool.execute(args)).isError).toBe(true)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('enforces new SID validation in the REST client, not only the tool schema', async () => {
    const { client, fetcher } = fixture()
    await expect(client.createOntologyEntity('c', 'd', { sid: 'dom.Class', displayName: '类' })).rejects.toThrow('sid')
    await expect(client.createOntologyProperty('c', 'd', { sid: 'bad-id' })).rejects.toThrow('sid')
    await expect(client.createOntologyRelationType('c', 'd', { sid: '关系' })).rejects.toThrow('sid')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('creates safe identifiers with Chinese display names and leaves old class/property references untouched', async () => {
    const { client, fetcher } = fixture()
    await client.createOntologyEntity('c', 'd', { sid: 'Instrument', displayName: '仪表', treeId: 'tree',
      parentClassSid: 'legacy.Class', instanceOf: ['legacy.OtherClass'], properties: { 'legacy.property': '中文' } })
    await client.createOntologyProperty('c', 'd', { sid: 'tag_number', displayName: '位号', kind: 'SCALAR', valueType: 'STRING' })
    await client.createOntologyRelationType('c', 'd', { sid: 'belongs_to_unit', displayName: '属于单元', sourceType: 'legacy.Class' })
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(requestBody(fetcher.mock.calls[0]?.[1]?.body)).toMatchObject({ sid: 'Instrument', displayName: '仪表',
      primarySubclassOf: 'legacy.Class', instanceOf: ['legacy.OtherClass'], statements: { 'legacy.property': [{ propId: 'legacy.property' }] } })
    expect(requestBody(fetcher.mock.calls[2]?.[1]?.body)).toMatchObject({ sid: 'belongs_to_unit', sourceType: 'legacy.Class' })
  })

  it('keeps existing dotted identifiers usable for queries and updates', async () => {
    const { client, fetcher } = fixture()
    await client.queryOntologyEntities('legacy.collection', 'legacy.domain')
    await client.updateOntologyEntity('c', 'd', 'legacy.Entity', { displayName: '更新' })
    await client.updateOntologyProperty('c', 'd', 'legacy.property', { description: '更新' })
    await client.updateOntologyRelationType('c', 'd', 'legacy.relation', { description: '更新' })
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(fetcher.mock.calls.map(([url]) => requestUrl(url)).join('\n')).toContain('legacy.Entity')
    expect(fetcher.mock.calls.map(([url]) => requestUrl(url)).join('\n')).toContain('legacy.property')
    expect(fetcher.mock.calls.map(([url]) => requestUrl(url)).join('\n')).toContain('legacy.relation')
  })

  it.each(['legacy.belongsToUnit', 'belongs_to_unit'])('resolves relation SID %s to the Web edge label while preserving entity SIDs', async (sid) => {
    const { client, fetcher } = fixture([{ ...definition, sid }])
    await client.createOntologyRelation(reference.collectionName, reference.domainName, { ...edge, relationSid: sid })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(requestUrl(fetcher.mock.calls[0]?.[0])).toContain('/schema/relations/effective')
    expect(fetcher.mock.calls[0]?.[1]?.method).toBeUndefined()
    expect(requestBody(fetcher.mock.calls[1]?.[1]?.body)).toEqual({ ...edge, relationSid: '属于单元' })
  })

  it('uses the original SID when the relation definition has no display name', async () => {
    const { client, fetcher } = fixture([{ kind: 'RELATION', sid: 'contains' }])
    await client.createOntologyRelation('c', 'd', { ...edge, relationSid: 'contains' })
    expect(requestBody(fetcher.mock.calls[1]?.[1]?.body)).toMatchObject({ relationSid: 'contains' })
  })

  it.each([
    [], {}, [definition, definition], [{ ...definition, kind: 'SCALAR' }],
    [{ ...definition, displayName: '包含.关系' }], [{ ...definition, displayName: '包含\n关系' }],
    [{ kind: 'RELATION', sid: edge.relationSid }],
    [definition, { kind: 'RELATION', sid: 'other', displayName: definition.displayName }],
    [definition, { kind: 'RELATION', sid: definition.displayName, displayName: '另一个' }],
  ])('does not POST an edge when definitions are missing, ambiguous or unsafe: %j', async (definitions) => {
    const { client, fetcher } = fixture(definitions)
    await expect(client.createOntologyRelation('c', 'd', edge)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[1]?.method).toBeUndefined()
  })

  it('rejects a display name supplied instead of an exact relation SID', async () => {
    const { client, fetcher } = fixture([definition])
    await expect(client.createOntologyRelation('c', 'd', { ...edge, relationSid: definition.displayName })).rejects.toThrow('SID')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('never retries a failed POST using a different relation label', async () => {
    const { client, fetcher } = fixture([definition])
    fetcher.mockImplementation(async (_url, init) => init?.method === 'POST'
      ? Response.json({ code: 500, msg: '服务器内部错误' }, { status: 500 }) : Response.json({ data: [definition] }))
    await expect(client.createOntologyRelation('c', 'd', edge)).rejects.toThrow('服务器内部错误')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('rejects unusable relation display names on definition creation and rename before requesting', async () => {
    const { client, fetcher } = fixture()
    await expect(client.createOntologyRelationType('c', 'd', { sid: 'contains', displayName: '包含.关系' })).rejects.toThrow('点号')
    await expect(client.createOntologyProperty('c', 'd', { sid: 'contains', kind: 'RELATION', displayName: '包含.关系' })).rejects.toThrow('点号')
    await expect(client.renameOntologyRelationType('c', 'd', 'legacy.contains', '包含.关系')).rejects.toThrow('点号')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
