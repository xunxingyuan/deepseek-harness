/** Embed the reviewed SheetJS input so installed plugins need no exotic transitive URL dependency. */
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { defineConfig } from 'tsdown'

function spreadsheetNotices(): string {
  const root = dirname(createRequire(import.meta.url).resolve('xlsx'))
  const notices = readdirSync(root).filter(name => /^(LICENSE|NOTICE)(\.|$)/u.test(name)).sort()
    .map(name => readFileSync(join(root, name), 'utf8')).join('\n')
  if (!notices.trim()) throw new Error('G1brain spreadsheet bundle requires SheetJS license notices')
  return ['//! Bundled SheetJS license notices', ...notices.trimEnd().split('\n').map(line => `// ${line}`)].join('\n')
}

export default defineConfig(({ env }) => env?.DSH_BUILD_FACE === 'client' ? [] : [{
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: { alwaysBundle: ['xlsx'] },
  banner: spreadsheetNotices(),
}])
