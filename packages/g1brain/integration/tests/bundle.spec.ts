import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('installed G1brain spreadsheet dependency', () => {
  it('keeps the pinned CDN tarball out of production dependency resolution', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(manifest.dependencies).not.toHaveProperty('xlsx')
    expect(manifest.devDependencies.xlsx).toBe('https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz')
    expect(Object.values(manifest.dependencies).some(specifier => /^https?:\/\//u.test(specifier))).toBe(false)
  })
})
