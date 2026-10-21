import { describe, expect, it } from 'vitest'
import { isSystemDomain, requireResourceName, resourceName } from '../src/names.ts'

describe('G1brain resource identifiers', () => {
  it.each(['设备本体', 'New ontology', '123report', '_schema', 'share', 'a/b?x=1', 'a'.repeat(100), '本体😀'])('converts %s into a stable, bounded ASCII name', (label) => {
    const name = resourceName(label, 'col', 'session-1')
    expect(name).toMatch(/^[a-z][a-z0-9_]{0,47}$/)
    expect(resourceName(label, 'col', 'session-1')).toBe(name)
    expect(resourceName(label, 'col', 'session-2')).not.toBe(name)
    expect(requireResourceName(name)).toBe(name)
  })
  it('retains explicit valid identifiers and rejects blank names or unsafe direct creation', () => {
    expect(resourceName('weekly_report_1', 'col')).toBe('weekly_report_1')
    expect(() => resourceName('  ', 'dom')).toThrow('blank')
    expect(() => requireResourceName('中文')).toThrow('displayName')
    expect(resourceName('中文', 'col')).not.toBe(resourceName('中文', 'dom'))
  })
  it.each(['_schema', '_shared', 'schema', 'share', 'shared', '_share', '_SCHEMA'])('recognizes system domain %s', (name) => {
    expect(isSystemDomain(name)).toBe(true)
  })
  it('does not exclude business domains whose names contain system words', () => {
    expect(isSystemDomain('common_domain')).toBe(false)
    expect(isSystemDomain('shared_equipment')).toBe(false)
  })
})
