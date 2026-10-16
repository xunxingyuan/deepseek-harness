import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/workflow-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/workflow.patch.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe('G1brain prepared Session through the real Loader', () => {
  it('creates resources directly and approves only the subsequent deletion', async () => {
    const result = await runLoaderSmoke({ label: 'G1brain prepared Session', tempDirPrefix: 'g1brain-workflow-',
      binScript: driver, libBinScript: driver, configPath, tsconfigPath,
      inspect: async (cwd) => {
        const proof: unknown = JSON.parse(await readFile(join(cwd, 'backend-proof.json'), 'utf8'))
        expect(proof).toEqual({ before: 16, after: 46,
          requests: ['collection:周报本体', 'domain:周报领域', 'library:周报文档库', 'upload:中文 Word.docx.md', 'upload:中文 Excel.xlsx.md', 'delete:obsolete-property'],
          output: '已读取中文材料并直接创建周报本体、领域和文档库；废弃属性经审批后删除。' })
        const files = await readdir(join(cwd, '.sessions'), { recursive: true })
        const file = files.find(file => /session\.v\d+\.jsonl$/.test(file))
        expect(file).toBeDefined()
        const events = (await readFile(join(cwd, '.sessions', file!), 'utf8')).trim().split('\n')
          .slice(1).map(line => JSON.parse(line) as SessionEvent)
        expect(events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual([
          'g1brain_list_selected_files', 'g1brain_read_selected_file', 'g1brain_read_selected_file', 'g1brain_read_selected_file', 'g1brain_create_ontology_collection',
          'g1brain_create_ontology_domain', 'g1brain_create_document_library', 'g1brain_upload_selected_files', 'g1brain_delete_ontology_property',
        ])
        expect(events.filter(event => event.type === 'approval/asked')).toHaveLength(1)
        expect(events.filter(event => event.type === 'approval/asked').map(event => event.data.toolName)).toEqual(['g1brain_delete_ontology_property'])
        expect(events.filter(event => event.type === 'approval/decided').map(event => event.data.outcome))
          .toEqual(['allowed-once'])
        expect(events.some(event => event.type === 'system/message' && JSON.stringify(event.data).includes('Use Simplified Chinese for Chinese requests'))).toBe(true)
      },
    })
    expect(result.stderr).not.toContain('UNHANDLED')
    expect(result.stdout).toContain('g1brain-workflow-result')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
