import { describe, expect, it } from 'vitest'
import { createG1BrainTools } from '../src/legacy/bridge/tools.ts'
import { DELETION_TOOLS, MUTATING_TOOLS, requiresDeletionApproval, scopedSchema } from '../src/legacy/bridge/policy.ts'
import { validateInput } from '../src/legacy/bridge/validate.ts'
import { createG1BrainClient } from '../src/legacy/g1brain/client.ts'
import { toHarnessToolSchema } from '../src/tool-schema.ts'

const client = createG1BrainClient({
  baseUrl: 'http://127.0.0.1:19091', authMode: 'local-dev', clientId: 'test', clientSecret: '',
  tenantId: '000000', publicKey: '', timeoutMs: 1000, localUserId: 'developer', localClientId: 'g1brain-web',
})

describe('G1brain legacy tool schema adaptation', () => {
  it('preserves all 51 tool argument structures and requires confirmation only for deletions', () => {
    const tools = createG1BrainTools({ client })
    expect(tools).toHaveLength(51)
    for (const tool of tools) {
      const mutating = MUTATING_TOOLS.has(tool.name)
      const deletion = DELETION_TOOLS.has(tool.name)
      const original = scopedSchema(tool.inputSchema, mutating, deletion)
      const adapted = toHarnessToolSchema(original)
      expect(adapted.type, tool.name).toBe('object')
      if (deletion) {
        expect(mutating).toBe(true)
        expect(original.required, tool.name).toContain('confirm')
        expect(() => { validateInput(original, {}) }).toThrow()
      } else if (!((tool.inputSchema.required ?? []) as string[]).includes('confirm')) {
        expect(original.required ?? [], tool.name).not.toContain('confirm')
      }
    }
    expect([...DELETION_TOOLS].sort()).toEqual(tools.filter(tool => tool.name.startsWith('g1brain_delete_')).map(tool => tool.name).sort())
  })

  it('treats replace imports as potentially deleting existing content', () => {
    expect(requiresDeletionApproval('g1brain_import_ontology_package', { replace: true })).toBe(true)
    expect(requiresDeletionApproval('g1brain_import_ontology_package', { replace: false })).toBe(false)
    expect(requiresDeletionApproval('g1brain_create_ontology_entity', {})).toBe(false)
    expect(requiresDeletionApproval('g1brain_update_ontology_entity', {})).toBe(false)
    expect(requiresDeletionApproval('g1brain_cancel_document_task', {})).toBe(false)
  })

  it('keeps legacy string and numeric limits enforced at execution', () => {
    const tool = createG1BrainTools({ client }).find(candidate => candidate.name === 'g1brain_query_ontology_entities')!
    const schema = scopedSchema(tool.inputSchema, false)
    expect(() => { validateInput(schema, { collectionName: '', domainName: '设备' }) }).toThrow('不能为空')
    expect(() => { validateInput(schema, { collectionName: '集合', domainName: '设备', size: 1000000 }) }).toThrow('大于最大值')
  })
})
