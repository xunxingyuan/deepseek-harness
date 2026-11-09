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
  it('retains embedded pictures through the real tool runtime without logging credentials', async () => {
    const result = await runLoaderSmoke({ label: 'G1brain image Session', tempDirPrefix: 'g1brain-images-workflow-',
      binScript: driver, libBinScript: driver, configPath, tsconfigPath, env: { G1BRAIN_TEST_IMAGES: '1' },
      inspect: async (cwd) => {
        const proof: unknown = JSON.parse(await readFile(join(cwd, 'backend-proof.json'), 'utf8'))
        expect(proof).toMatchObject({ before: 16, after: 46, output: '已保留 Word 图片并上传，文档中的图片使用静态资源永久链接。' })
        expect(proof).toHaveProperty('requests', expect.arrayContaining(['static-picture-upload', 'upload:中文 图片.docx.md']))
        const files = await readdir(join(cwd, '.sessions'), { recursive: true })
        const file = files.find(file => /session\.v\d+\.jsonl$/.test(file))
        if (!file) throw new Error('Missing durable Session')
        const log = await readFile(join(cwd, '.sessions', file), 'utf8')
        expect(log).not.toContain('fixture-token')
        expect(log).not.toContain('fixture-secret')
        const events = log.trim().split('\n').slice(1).map(line => JSON.parse(line) as SessionEvent)
        expect(events.filter(event => event.type === 'approval/asked')).toHaveLength(0)
        expect(events.some(event => event.type === 'tool/result' && JSON.stringify(event.data).includes('imageCount'))).toBe(true)
      },
    })
    expect(result.stderr).not.toContain('UNHANDLED')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('rejects unsafe new SIDs and resolves existing relation SIDs through the shipped tool runtime', async () => {
    const result = await runLoaderSmoke({ label: 'G1brain SID Session', tempDirPrefix: 'g1brain-sid-workflow-',
      binScript: driver, libBinScript: driver, configPath, tsconfigPath, env: { G1BRAIN_TEST_SID: '1' },
      inspect: async (cwd) => {
        const proof: unknown = JSON.parse(await readFile(join(cwd, 'backend-proof.json'), 'utf8'))
        expect(proof).toMatchObject({ before: 16, after: 46,
          output: '已拒绝不合规新 SID，普通 SID 与旧关系 SID 均按显示名写入。',
        })
        expect(proof).toHaveProperty('requests', expect.arrayContaining(['property:tag_number', 'relation-type:belongs_to_unit', 'edge:属于单元', 'edge:兼容包含']))
        const files = await readdir(join(cwd, '.sessions'), { recursive: true })
        const file = files.find(file => /session\.v\d+\.jsonl$/.test(file))
        if (!file) throw new Error('Missing durable Session')
        const events = (await readFile(join(cwd, '.sessions', file), 'utf8')).trim().split('\n').slice(1).map(line => JSON.parse(line) as SessionEvent)
        expect(events.filter(event => event.type === 'approval/asked')).toHaveLength(0)
        expect(events.some(event => event.type === 'tool/result' && JSON.stringify(event.data).includes('格式无效'))).toBe(true)
      },
    })
    expect(result.stderr).not.toContain('UNHANDLED')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('splits mixed Excel and uses collection-bound SQL through the shipped tool runtime', async () => {
    const result = await runLoaderSmoke({ label: 'G1brain Excel Session', tempDirPrefix: 'g1brain-excel-workflow-',
      binScript: driver, libBinScript: driver, configPath, tsconfigPath, env: { G1BRAIN_TEST_TABLES: '1' },
      inspect: async (cwd) => {
        const proof: unknown = JSON.parse(await readFile(join(cwd, 'backend-proof.json'), 'utf8'))
        expect(proof).toMatchObject({ before: 16, after: 55,
          output: '已分流 Excel：数据表导入完成，说明进入文档库；SQL 总产量为 215。',
        })
        expect(proof).toHaveProperty('requests', expect.arrayContaining([
          'table-collection:周报领域', 'table-upload:生产数据', 'upload:混合数据.xlsx.notes.md', 'table-read:query_tables',
        ]))
        const files = await readdir(join(cwd, '.sessions'), { recursive: true })
        const file = files.find(file => /session\.v\d+\.jsonl$/.test(file))
        if (!file) throw new Error('Missing durable Session')
        const events = (await readFile(join(cwd, '.sessions', file), 'utf8')).trim().split('\n').slice(1).map(line => JSON.parse(line) as SessionEvent)
        expect(events.filter(event => event.type === 'approval/asked')).toHaveLength(0)
        expect(events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toContain('g1brain_get_table_imports')
        expect(events.some(event => event.type === 'tool/result' && JSON.stringify(event.data).includes('215'))).toBe(true)
      },
    })
    expect(result.stderr).not.toContain('UNHANDLED')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('creates resources directly and approves only the subsequent deletion', async () => {
    const result = await runLoaderSmoke({ label: 'G1brain prepared Session', tempDirPrefix: 'g1brain-workflow-',
      binScript: driver, libBinScript: driver, configPath, tsconfigPath,
      inspect: async (cwd) => {
        const proof: unknown = JSON.parse(await readFile(join(cwd, 'backend-proof.json'), 'utf8'))
        expect(proof).toEqual({ before: 16, after: 46,
          requests: ['collection:col_7c120e3057d72928f5491e86', 'domain:dom_e4d35bcec9eb3d594c4bdeb7', 'domain-display:周报领域', 'library:周报文档库', 'upload:中文 Word.docx.md', 'upload:中文 Excel.xlsx.md', 'delete:obsolete-property'],
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
