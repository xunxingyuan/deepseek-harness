import { setTimeout as delay } from 'node:timers/promises'
import type { G1BrainClient } from '../g1brain/client.ts'
import { ScopeError } from '../errors.ts'
import type { DocumentTaskSubmission, PreparedTask, ToolResult } from '../types.ts'
import type { WorkspaceScope } from './scope.ts'
import { requireResourceName, resourceName } from '../../names.ts'

/** Model-facing legacy G1brain operation before Harness registration. */
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>
}

/** Per-call REST client and selected Session material/target context. */
export interface BridgeContext {
  client: G1BrainClient
  scope?: WorkspaceScope
  task?: PreparedTask
}

const documentCollection = {
  type: 'string', minLength: 1,
  description: '文档库集合的 API name，普通会话先列出文档库取其 name；绑定会话取自 g1brain_context.task.documentLibraryName 或 createDocumentLibraryName。不是本体集合名、领域名或 displayName。',
}

function text(value: unknown): ToolResult {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  const result: ToolResult = {
    content: [{ type: 'text', text: serialized }],
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) result.structuredContent = value
  return result
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`参数 ${name} 必须是非空字符串`)
  return value.trim()
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`参数 ${name} 必须是字符串`)
  return value.trim() || undefined
}

function requiredBoolean(args: Record<string, unknown>, name: string): boolean {
  if (args[name] !== true) throw new Error(`参数 ${name}=true 是此写操作的必需确认项`)
  return true
}

function filesArgument(args: Record<string, unknown>): string[] | undefined {
  const value = args.files
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error('参数 files 必须是相对路径字符串数组')
  }
  return value as string[]
}

function optionalNumber(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || Number.isNaN(value)) throw new Error(`参数 ${name} 必须是有效数字`)
  return value
}

function optionalBoolean(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`参数 ${name} 必须是布尔值`)
  return value
}

function optionalObject(args: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const value = args[name]
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`参数 ${name} 必须是对象`)
  return value as Record<string, unknown>
}

function optionalStringArray(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`参数 ${name} 必须是字符串数组`)
  }
  return value as string[]
}

function documentIdsArgument(args: Record<string, unknown>): number[] | undefined {
  const value = args.mdIds
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(id => !Number.isSafeInteger(id) || id <= 0)
    || new Set(value).size !== value.length) throw new Error('mdIds 必须是不重复的正整数数组')
  return value as number[]
}

async function resolveDocumentTaskIds(client: G1BrainClient, collectionName: string, args: Record<string, unknown>): Promise<number[]> {
  const selection = requiredString(args, 'fileSelection')
  const requested = documentIdsArgument(args)
  if (selection === 'all' && requested !== undefined) throw new Error('选择所有文件时不要传入 mdIds')
  if (selection === 'selected' && (!requested || requested.length === 0)) throw new Error('指定文件时必须传入 mdIds')
  const available = (await client.listMdDocuments(collectionName)).flatMap((item) => {
    if (typeof item !== 'object' || item === null || !('id' in item) || !Number.isSafeInteger(item.id)) return []
    return [item.id as number]
  })
  if (selection === 'all') {
    if (available.length === 0) throw new Error('目标文档库没有可处理的文件')
    return available
  }
  if (selection !== 'selected' || !requested) throw new Error('fileSelection 必须是 all 或 selected')
  const allowed = new Set(available)
  if (requested.some(id => !allowed.has(id))) throw new Error('mdIds 包含不属于当前文档库的文件')
  return requested
}

function documentTaskSummary(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('G1brain 任务响应无效')
  const task = value as Record<string, unknown>
  const ids = Array.isArray(task.objectIds) ? task.objectIds : []
  const summary: Record<string, unknown> = { fileCount: ids.length }
  for (const key of ['taskId', 'collection', 'type', 'status', 'operations', 'createdAt', 'completedAt',
    'retryCount', 'terminal', 'allSuccess', 'error']) if (key in task) summary[key] = task[key]
  if (!('type' in summary) && typeof task.taskType === 'string') summary.type = task.taskType
  if (!('operations' in summary) && typeof task.params === 'object' && task.params !== null
    && 'operations' in task.params) summary.operations = task.params.operations
  return summary
}

function taskListResult(tasks: unknown[], limit: number): { total: number; tasks: Record<string, unknown>[] } {
  return { total: tasks.length, tasks: tasks.slice(0, limit).map(documentTaskSummary) }
}

async function withToolError(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run()
  } catch (error) {
    return {
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    }
  }
}

/** Construct ontology, document, and agent operations for one bound context.
 * @param context - REST client and selected Session scope.
 * @returns tool definitions with deferred operation bodies.
 */
export function createG1BrainTools(context: BridgeContext): ToolDefinition[] {
  const { client } = context
  const scope = () => {
    if (!context.scope) throw new Error('当前会话未绑定资料目录')
    return context.scope
  }
  return [
    {
      name: 'g1brain_context',
      description: '返回当前任务的安全上下文，不包含任何访问令牌。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: () => Promise.resolve(text({
        task: context.task ?? null,
        workspaceRoot: scope().rootPath,
        note: '文件工具只接受相对于 workspaceRoot 的路径。',
      })),
    },
    {
      name: 'g1brain_list_selected_files',
      description: '列出所选本地资料目录中的文件及格式；DOC、PDF 和 PowerPoint 原件须先转换为支持的 DOCX、XLSX 或 UTF-8 Markdown。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: () => withToolError(async () => text((await scope().listFiles())
        .map(({ relativePath, size, extension }) => ({ relativePath, size, extension })))),
    },
    {
      name: 'g1brain_read_selected_file',
      description: '读取所选目录内的 UTF-8/带 BOM 的 UTF-16 文本，或提取 DOCX、XLSX、XLS 的正文与表格（Excel 按工作表分组）。不执行宏、公式或图片 OCR；DOC/PDF/PPT 须先转换，不能按文本解码。path 必须是相对路径；maxBytes 限制提取后完整正文的 UTF-8 字节数，超限时报错，不返回截断内容。',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, maxBytes: { type: 'integer', minimum: 1, maximum: 5000000 } },
        required: ['path'],
        additionalProperties: false,
      },
      execute: args =>
        withToolError(async () => {
          const path = requiredString(args, 'path')
          const maxBytes = typeof args.maxBytes === 'number' ? args.maxBytes : 2 * 1024 * 1024
          if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 5_000_000) throw new Error('文件读取上限无效')
          return text(await scope().read(path, maxBytes))
        }),
    },
    {
      name: 'g1brain_list_document_libraries',
      description: '列出 G1brain 文档库。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: () => withToolError(async () => text(await client.listMdLibraries())),
    },
    {
      name: 'g1brain_create_document_library',
      description: '创建一个 G1brain 文档库。',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', minLength: 1 } },
        required: ['name'],
        additionalProperties: false,
      },
      execute: args => withToolError(async () => text(await client.createMdLibrary(requiredString(args, 'name')))),
    },
    {
      name: 'g1brain_list_documents',
      description: '列出指定文档库中的文件。',
      inputSchema: {
        type: 'object',
        properties: { collectionName: documentCollection },
        required: ['collectionName'],
        additionalProperties: false,
      },
      execute: args =>
        withToolError(async () => text(await client.listMdDocuments(requiredString(args, 'collectionName')))),
    },
    {
      name: 'g1brain_upload_selected_files',
      description: '将明确列出的文件先提取为 UTF-8 Markdown，再上传到绑定文档库；支持文本、DOCX、XLSX、XLS。非 Markdown 文件保留原文件名并追加 .md；原文件不变。所有文件均解析成功且上传名称不冲突后才开始上传，不会将 Office 二进制当正文上传。上传后须提交 MD 切片任务，再提交 CHUNK 关键词、向量化或索引任务；上传本身不代表可检索。',
      inputSchema: {
        type: 'object',
        properties: {
          collectionName: documentCollection,
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['collectionName', 'files'],
        additionalProperties: false,
      },
      execute: args =>
        withToolError(async () => {
          const collectionName = requiredString(args, 'collectionName')
          const requested = filesArgument(args)
          if (requested === undefined || requested.length === 0) throw new Error('必须明确列出至少一个相对路径文件')
          const selected = await scope().prepareUploads(requested)
          const results: Array<{ path: string; uploadName: string; result: unknown }> = []
          for (const file of selected) {
            const result = await client.uploadMdFile(collectionName, file.uploadName, file.contents)
            results.push({ path: file.path, uploadName: file.uploadName, result })
          }
          return text({ uploaded: results.length, results })
        }),
    },
    {
      name: 'g1brain_submit_document_task',
      description: '为当前文档库提交处理任务。先以 MD 执行切片，再以 CHUNK 执行关键词、向量化及索引创建；可选择当前库所有文件，或指定已列出的文件 ID。提交后用任务详情确认完成，失败时修正后重新提交。',
      inputSchema: { type: 'object', properties: {
        collectionName: documentCollection,
        type: { type: 'string', enum: ['MD', 'CHUNK'] },
        fileSelection: { type: 'string', enum: ['all', 'selected'] },
        mdIds: { type: 'array', items: { type: 'integer', minimum: 1 } },
        operations: { type: 'array', items: { type: 'string', enum: ['keywords', 'vectorization', 'indexCreate'] } },
      }, required: ['collectionName', 'type', 'fileSelection'], additionalProperties: false },
      execute: args => withToolError(async () => {
        const collectionName = requiredString(args, 'collectionName')
        const mdIds = await resolveDocumentTaskIds(client, collectionName, args)
        const type = requiredString(args, 'type')
        let submission: DocumentTaskSubmission
        if (type === 'MD') {
          if (args.operations !== undefined) throw new Error('MD 任务固定执行切片，不接受 operations')
          submission = { type: 'MD', operations: ['slice'], mdIds, mdType: 'simple', chunkMetadata: {}, chunkSize: 512 }
        } else if (type === 'CHUNK') {
          const operations = optionalStringArray(args, 'operations')
          const allowed = new Set(['keywords', 'vectorization', 'indexCreate'])
          if (!operations?.length || new Set(operations).size !== operations.length
            || operations.some(operation => !allowed.has(operation))) throw new Error('CHUNK 任务须选择不重复的关键词、向量化或索引操作')
          submission = { type: 'CHUNK', mdIds, operations: operations as Array<'keywords' | 'vectorization' | 'indexCreate'>,
            embeddingMetadata: { keywords: 'keywords', llm_questions: 'faqs', _currentSectionToc: 'ToC', _heading: 'heading' },
            chunkMetadata: { _fileName: '文件名称', _currentSectionToc: '文档层级结构', _heading: '该段标题' }, extraContent: [] }
        } else throw new Error('任务类型必须是 MD 或 CHUNK')
        return text({ fileCount: mdIds.length, submission: await client.submitMdTask(collectionName, submission) })
      }),
    },
    {
      name: 'g1brain_list_document_tasks',
      description: '列出当前文档库的处理任务及整体状态。返回摘要；需要单个任务详情时使用任务 ID 查询。',
      inputSchema: { type: 'object', properties: {
        collectionName: documentCollection, limit: { type: 'integer', minimum: 1, maximum: 100 },
      }, required: ['collectionName'], additionalProperties: false },
      execute: args => withToolError(async () => text(taskListResult(
        await client.listMdTasks(requiredString(args, 'collectionName')), optionalNumber(args, 'limit') ?? 30,
      ))),
    },
    {
      name: 'g1brain_list_document_task_history',
      description: '列出当前文档库的历史处理任务及整体状态。',
      inputSchema: { type: 'object', properties: {
        collectionName: documentCollection, limit: { type: 'integer', minimum: 1, maximum: 100 },
      }, required: ['collectionName'], additionalProperties: false },
      execute: args => withToolError(async () => text(taskListResult(
        await client.listMdTaskHistory(requiredString(args, 'collectionName')), optionalNumber(args, 'limit') ?? 30,
      ))),
    },
    {
      name: 'g1brain_get_document_task',
      description: '按任务 ID 查询当前文档库处理任务的整体状态、处理数量和错误。',
      inputSchema: { type: 'object', properties: {
        collectionName: documentCollection, taskId: { type: 'string', minLength: 1 },
      }, required: ['collectionName', 'taskId'], additionalProperties: false },
      execute: args => withToolError(async () => text(documentTaskSummary(await client.getMdTask(
        requiredString(args, 'collectionName'), requiredString(args, 'taskId'),
      )))),
    },
    {
      name: 'g1brain_get_document_task_file_statuses',
      description: '按任务 ID 查询当前文档库中每个文件的处理步骤状态；结果最多返回 100 个文件，可用 fileId 聚焦。',
      inputSchema: { type: 'object', properties: {
        collectionName: documentCollection, taskId: { type: 'string', minLength: 1 },
        fileId: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
      }, required: ['collectionName', 'taskId'], additionalProperties: false },
      execute: args => withToolError(async () => {
        const value = await client.getMdTaskFileStatuses(requiredString(args, 'collectionName'), requiredString(args, 'taskId'))
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('G1brain 文件任务状态响应无效')
        const entries = Object.entries(value as Record<string, unknown>)
        const fileId = optionalNumber(args, 'fileId')
        const selected = fileId === undefined ? entries : entries.filter(([id]) => id === String(fileId))
        return text({ total: entries.length, files: selected.slice(0, optionalNumber(args, 'limit') ?? 30)
          .map(([id, status]) => ({ fileId: id, status })) })
      }),
    },
    {
      name: 'g1brain_wait_document_task',
      description: '等待当前文档库指定处理任务结束，最长 60 秒；超时后返回最新状态，可继续查询或再次等待。',
      inputSchema: { type: 'object', properties: {
        collectionName: documentCollection, taskId: { type: 'string', minLength: 1 },
        maxWaitSeconds: { type: 'integer', minimum: 1, maximum: 60 },
      }, required: ['collectionName', 'taskId'], additionalProperties: false },
      execute: (args, signal) => withToolError(async () => {
        const collectionName = requiredString(args, 'collectionName')
        const taskId = requiredString(args, 'taskId')
        const maxWaitSeconds = optionalNumber(args, 'maxWaitSeconds') ?? 20
        const deadline = Date.now() + maxWaitSeconds * 1000
        while (true) {
          if (signal?.aborted) throw signal.reason
          const task = await client.getMdTask(collectionName, taskId, signal)
          const summary = documentTaskSummary(task)
          if (summary.terminal === true || ['SUCCESS', 'FAILED', 'CANCELLED'].includes(String(summary.status).toUpperCase())) {
            return text({ completed: true, task: summary })
          }
          const remaining = deadline - Date.now()
          if (remaining <= 0) return text({ completed: false, task: summary })
          await delay(Math.min(2000, remaining), undefined, { signal })
        }
      }),
    },
    {
      name: 'g1brain_cancel_document_task',
      description: '取消当前文档库指定的运行中处理任务，不删除文档；无需额外审批。',
      inputSchema: { type: 'object', properties: {
        collectionName: documentCollection, taskId: { type: 'string', minLength: 1 },
      }, required: ['collectionName', 'taskId'], additionalProperties: false },
      execute: args => withToolError(async () => text(await client.cancelMdTask(
        requiredString(args, 'collectionName'), requiredString(args, 'taskId'),
      ))),
    },
    {
      name: 'g1brain_hybrid_search',
      description: '在 G1brain 文档库中执行混合检索。',
      inputSchema: {
        type: 'object',
        properties: {
          collectionName: documentCollection,
          query: { type: 'string', minLength: 1 },
        },
        required: ['collectionName', 'query'],
        additionalProperties: false,
      },
      execute: args =>
        withToolError(async () =>
          text(await client.hybridSearch(requiredString(args, 'collectionName'), requiredString(args, 'query'))),
        ),
    },
    // --- P2: Document Locating & QA ---
    {
      name: 'g1brain_locate_document_chunks',
      description: '在指定文档库中按文本内容或章节标题精确定位文档片段和命中位置。',
      inputSchema: {
        type: 'object',
        properties: {
          collectionName: documentCollection,
          fileName: { type: 'string', minLength: 1 },
          text: { type: 'string' },
          headings: { type: 'array', items: { type: 'string' } },
        },
        required: ['collectionName', 'fileName'],
        additionalProperties: false,
      },
      execute: args =>
        withToolError(async () =>
          text(
            await client.locateDocumentChunks(
              requiredString(args, 'collectionName'),
              requiredString(args, 'fileName'),
              optionalString(args, 'text'),
              optionalStringArray(args, 'headings'),
            ),
          ),
        ),
    },
    {
      name: 'g1brain_list_document_chunks',
      description: '获取指定文档库的所有文档切片分块信息。',
      inputSchema: {
        type: 'object',
        properties: { collectionName: documentCollection },
        required: ['collectionName'],
        additionalProperties: false,
      },
      execute: args =>
        withToolError(async () =>
          text(await client.listDocumentChunks(requiredString(args, 'collectionName'))),
        ),
    },
    {
      name: 'g1brain_qa_search',
      description: '在指定 QA 问答库中执行语义检索与混合搜索。',
      inputSchema: {
        type: 'object',
        properties: {
          collectionName: documentCollection,
          query: { type: 'string', minLength: 1 },
        },
        required: ['collectionName', 'query'],
        additionalProperties: false,
      },
      execute: args =>
        withToolError(async () =>
          text(await client.qaSearch(requiredString(args, 'collectionName'), requiredString(args, 'query'))),
        ),
    },
    // --- Ontology Collections & Domains ---
    {
      name: 'g1brain_list_ontology_collections',
      description: '列出 G1brain 本体集合。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: () => withToolError(async () => text(await client.listOntologyCollections())),
    },
    {
      name: 'g1brain_create_ontology_collection',
      description: '创建本体集合。绑定会话必须使用 g1brain_context 中的 createOntologyCollectionName，中文名称保存在 displayName，不得作为后续 API 标识。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1 },
          displayName: { type: 'string', minLength: 1 },
          description: { type: 'string' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      execute: args => withToolError(async () => {
        const requested = requiredString(args, 'name')
        const name = context.task ? requireResourceName(requested) : resourceName(requested, 'col')
        const displayName = context.task?.createOntologyCollectionDisplayName ?? optionalString(args, 'displayName') ?? requested
        const result = await client.createOntologyCollection(name, optionalString(args, 'description') ?? '', displayName)
        return text({ name, displayName, result })
      }),
    },
    {
      name: 'g1brain_list_ontology_domains',
      description: '列出指定本体集合的领域。',
      inputSchema: {
        type: 'object',
        properties: { collectionName: { type: 'string', minLength: 1 } },
        required: ['collectionName'],
        additionalProperties: false,
      },
      execute: args =>
        withToolError(async () => text(await client.listOntologyDomains(requiredString(args, 'collectionName')))),
    },
    {
      name: 'g1brain_create_ontology_domain',
      description: '创建本体领域。绑定会话必须使用 g1brain_context 中的 createDomainName；中文显示名保存在领域配置中，后续操作仍使用 API name。',
      inputSchema: {
        type: 'object',
        properties: {
          collectionName: { type: 'string', minLength: 1 },
          name: { type: 'string', minLength: 1 },
          displayName: { type: 'string', minLength: 1 },
        },
        required: ['collectionName', 'name'],
        additionalProperties: false,
      },
      execute: args => withToolError(async () => {
        const requested = requiredString(args, 'name')
        const name = context.task ? requireResourceName(requested) : resourceName(requested, 'dom')
        const displayName = context.task?.createDomainDisplayName ?? optionalString(args, 'displayName') ?? requested
        const result = await client.createOntologyDomain(requiredString(args, 'collectionName'), name, displayName)
        return text({ name, displayName, result })
      }),
    },
    // --- P0: Ontology Query, Detail, Relations & Export ---
    {
      name: 'g1brain_query_ontology_entities',
      description: '查询或搜索指定本体领域的实体（类或个体）。支持关键词匹配或分页列表。',
      inputSchema: {
        type: 'object',
        properties: {
          collectionName: { type: 'string', minLength: 1 },
          domainName: { type: 'string', minLength: 1 },
          keyword: { type: 'string' },
          page: { type: 'integer', minimum: 1 },
          size: { type: 'integer', minimum: 1, maximum: 500 },
        },
        required: ['collectionName', 'domainName'],
        additionalProperties: false,
      },
      execute: args =>
        withToolError(async () =>
          text(
            await client.queryOntologyEntities(
              requiredString(args, 'collectionName'),
              requiredString(args, 'domainName'),
              optionalString(args, 'keyword'),
              optionalNumber(args, 'page'),
              optionalNumber(args, 'size'),
            ),
          ),
        ),
    },
    {
      name: 'g1brain_get_ontology_entity_detail',
      description: '获取指定实体的详细信息及其全部有效属性（含继承属性与实例）。',
      inputSchema: {
        type: 'object',
        properties: {
          collectionName: { type: 'string', minLength: 1 },
          domainName: { type: 'string', minLength: 1 },
          entitySid: { type: 'string', minLength: 1 },
        },
        required: ['collectionName', 'domainName', 'entitySid'],
        additionalProperties: false,
      },
      execute: args =>
        withToolError(async () =>
          text(
            await client.getOntologyEntityDetail(
              requiredString(args, 'collectionName'),
              requiredString(args, 'domainName'),
              requiredString(args, 'entitySid'),
            ),
          ),
        ),
    },
    {
      name: 'g1brain_get_ontology_relations',
      description: '获取领域内的关系列表，或按实体 SID 查询其关联的出边、入边或双向关系。',
      inputSchema: {
        type: 'object',
        properties: {
          collectionName: { type: 'string', minLength: 1 },
          domainName: { type: 'string', minLength: 1 },
          entitySid: { type: 'string' },
          direction: { type: 'string', enum: ['in', 'out', 'both'] },
          page: { type: 'integer', minimum: 1 },
          size: { type: 'integer', minimum: 1, maximum: 500 },
        },
        required: ['collectionName', 'domainName'],
        additionalProperties: false,
      },
      execute: args =>
        withToolError(async () =>
          text(
            await client.getOntologyRelations(
              requiredString(args, 'collectionName'),
              requiredString(args, 'domainName'),
              optionalString(args, 'entitySid'),
              optionalString(args, 'direction'),
              optionalNumber(args, 'page'),
              optionalNumber(args, 'size'),
            ),
          ),
        ),
    },
    {
      name: 'g1brain_export_ontology_package',
      description: '导出指定集合或领域的完整本体定义包 JSON，供模型结构比对或增量参考。',
      inputSchema: {
        type: 'object',
        properties: {
          collectionName: { type: 'string', minLength: 1 },
          domains: { type: 'array', items: { type: 'string' } },
          mode: { type: 'string', enum: ['full', 'schema', 'instances'] },
        },
        required: ['collectionName'],
        additionalProperties: false,
      },
      execute: args =>
        withToolError(async () =>
          text(
            await client.exportOntologyPackage(
              requiredString(args, 'collectionName'),
              optionalStringArray(args, 'domains'),
              optionalString(args, 'mode'),
            ),
          ),
        ),
    },
    // --- P1: Fine-Grained Entity, Relation & Property Operations ---
    {
      name: 'g1brain_create_ontology_entity',
      description: '在指定领域内创建实体。properties 只接受字符串、有限数字或布尔值；复杂值和多值属性请使用 statements。',
      inputSchema: {
        type: 'object',
        properties: {
          collectionName: { type: 'string', minLength: 1 },
          domainName: { type: 'string', minLength: 1 },
          sid: { type: 'string', minLength: 1 },
          displayName: { type: 'string', minLength: 1 },
          isClass: { type: 'boolean' },
          parentClassSid: { type: 'string' },
          instanceOf: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
          properties: { type: 'object' },
          statements: { type: 'object', additionalProperties: { type: 'array', items: { type: 'object', properties: {
            propId: { type: 'string' }, value: { type: 'object', properties: { type: { type: 'string', enum: ['STRING', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'DATE', 'DATETIME', 'JSON', 'QUANTITY', 'GEO', 'URL', 'ENTITY_REF', 'PROPERTY_REF', 'MEDIA_REF', 'UNKNOWN'] }, literal: {}, value: {} }, required: ['type'] },
          }, required: ['value'] } } },
          treeId: { type: 'string' },
        },
        required: ['collectionName', 'domainName', 'sid', 'displayName'],
        additionalProperties: false,
      },
      execute: args =>
        withToolError(async () =>
          text(
            await client.createOntologyEntity(
              requiredString(args, 'collectionName'),
              requiredString(args, 'domainName'),
              {
                sid: requiredString(args, 'sid'),
                displayName: requiredString(args, 'displayName'),
                isClass: optionalBoolean(args, 'isClass'),
                parentClassSid: optionalString(args, 'parentClassSid'),
                instanceOf: optionalStringArray(args, 'instanceOf'),
                description: optionalString(args, 'description'),
                properties: optionalObject(args, 'properties'),
                statements: optionalObject(args, 'statements'),
                treeId: optionalString(args, 'treeId'),
              },
            ),
          ),
        ),
    },
    {
      name: 'g1brain_update_ontology_entity',
      description: '更新指定实体的属性或基本信息，支持增量更新。',
      inputSchema: {
        type: 'object',
        properties: {
          collectionName: { type: 'string', minLength: 1 },
          domainName: { type: 'string', minLength: 1 },
          entitySid: { type: 'string', minLength: 1 },
          properties: { type: 'object' },
          incremental: { type: 'boolean' },
        },
        required: ['collectionName', 'domainName', 'entitySid', 'properties'],
        additionalProperties: false,
      },
      execute: args =>
        withToolError(async () =>
          text(
            await client.updateOntologyEntity(
              requiredString(args, 'collectionName'),
              requiredString(args, 'domainName'),
              requiredString(args, 'entitySid'),
              optionalObject(args, 'properties') ?? {},
              optionalBoolean(args, 'incremental'),
            ),
          ),
        ),
    },
    {
      name: 'g1brain_delete_ontology_entity',
      description: '按节点 ID 删除单个实体。必须同时提供从实体详情读取的 SID；删除前会再次核对 ID 与 SID。',
      inputSchema: { type: 'object', properties: {
        collectionName: { type: 'string', minLength: 1 }, domainName: { type: 'string', minLength: 1 },
        nodeId: { type: 'string', pattern: '^[1-9][0-9]*$' }, expectedSid: { type: 'string', minLength: 1 },
      }, required: ['collectionName', 'domainName', 'nodeId', 'expectedSid'], additionalProperties: false },
      execute: args => withToolError(async () => text(await client.deleteOntologyEntity(
        requiredString(args, 'collectionName'), requiredString(args, 'domainName'),
        requiredString(args, 'nodeId'), requiredString(args, 'expectedSid'),
      ))),
    },
    {
      name: 'g1brain_create_ontology_relation',
      description: '在两个实体之间创建拓扑关系（从 fromSid 指向 toSid）。',
      inputSchema: {
        type: 'object',
        properties: {
          collectionName: { type: 'string', minLength: 1 },
          domainName: { type: 'string', minLength: 1 },
          fromSid: { type: 'string', minLength: 1 },
          toSid: { type: 'string', minLength: 1 },
          relationSid: { type: 'string', minLength: 1 },
          properties: { type: 'object' },
        },
        required: ['collectionName', 'domainName', 'fromSid', 'toSid', 'relationSid'],
        additionalProperties: false,
      },
      execute: args =>
        withToolError(async () =>
          text(
            await client.createOntologyRelation(
              requiredString(args, 'collectionName'),
              requiredString(args, 'domainName'),
              {
                fromSid: requiredString(args, 'fromSid'),
                toSid: requiredString(args, 'toSid'),
                relationSid: requiredString(args, 'relationSid'),
                properties: optionalObject(args, 'properties'),
              },
            ),
          ),
        ),
    },
    {
      name: 'g1brain_delete_ontology_relation',
      description: '删除指定的实体关系。',
      inputSchema: {
        type: 'object',
        properties: {
          collectionName: { type: 'string', minLength: 1 },
          domainName: { type: 'string', minLength: 1 },
          relationId: { type: 'string', minLength: 1 },
        },
        required: ['collectionName', 'domainName', 'relationId'],
        additionalProperties: false,
      },
      execute: args =>
        withToolError(async () =>
          text(
            await client.deleteOntologyRelation(
              requiredString(args, 'collectionName'),
              requiredString(args, 'domainName'),
              requiredString(args, 'relationId'),
            ),
          ),
        ),
    },
    {
      name: 'g1brain_list_ontology_properties',
      description: '获取指定领域内的属性定义列表，用于核对属性字典与数据类型。',
      inputSchema: {
        type: 'object',
        properties: {
          collectionName: { type: 'string', minLength: 1 },
          domainName: { type: 'string', minLength: 1 },
          page: { type: 'integer', minimum: 1 },
          size: { type: 'integer', minimum: 1, maximum: 500 },
        },
        required: ['collectionName', 'domainName'],
        additionalProperties: false,
      },
      execute: args =>
        withToolError(async () =>
          text(
            await client.listOntologyProperties(
              requiredString(args, 'collectionName'),
              requiredString(args, 'domainName'),
              optionalNumber(args, 'page'),
              optionalNumber(args, 'size'),
            ),
          ),
        ),
    },
    {
      name: 'g1brain_list_entity_taxonomy_nodes',
      description: '读取当前领域的实体分类树节点，创建实体时可用其 ID 指定位置。',
      inputSchema: { type: 'object', properties: { collectionName: { type: 'string', minLength: 1 }, domainName: { type: 'string', minLength: 1 } }, required: ['collectionName', 'domainName'], additionalProperties: false },
      execute: args => withToolError(async () => text(await client.listEntityTaxonomyNodes(requiredString(args, 'collectionName'), requiredString(args, 'domainName')))),
    },
    {
      name: 'g1brain_list_ontology_relation_definitions',
      description: '读取当前领域生效的关系类型定义，区别于实体之间的关系边。',
      inputSchema: { type: 'object', properties: { collectionName: { type: 'string', minLength: 1 }, domainName: { type: 'string', minLength: 1 } }, required: ['collectionName', 'domainName'], additionalProperties: false },
      execute: args => withToolError(async () => text(await client.listEffectiveRelationDefinitions(requiredString(args, 'collectionName'), requiredString(args, 'domainName')))),
    },
    {
      name: 'g1brain_list_ontology_relation_types',
      description: '分页列出领域内直接定义的关系类型，区别于继承后的生效关系定义。',
      inputSchema: { type: 'object', properties: {
        collectionName: { type: 'string', minLength: 1 }, domainName: { type: 'string', minLength: 1 },
        page: { type: 'integer', minimum: 1 }, size: { type: 'integer', minimum: 1, maximum: 500 },
      }, required: ['collectionName', 'domainName'], additionalProperties: false },
      execute: args => withToolError(async () => text(await client.listOntologyRelationTypes(
        requiredString(args, 'collectionName'), requiredString(args, 'domainName'),
        optionalNumber(args, 'page'), optionalNumber(args, 'size'),
      ))),
    },
    {
      name: 'g1brain_get_ontology_relation_type',
      description: '按 SID 获取领域内一个关系类型定义。',
      inputSchema: { type: 'object', properties: {
        collectionName: { type: 'string', minLength: 1 }, domainName: { type: 'string', minLength: 1 }, relationSid: { type: 'string', minLength: 1 },
      }, required: ['collectionName', 'domainName', 'relationSid'], additionalProperties: false },
      execute: args => withToolError(async () => text(await client.getOntologyRelationType(
        requiredString(args, 'collectionName'), requiredString(args, 'domainName'), requiredString(args, 'relationSid'),
      ))),
    },
    {
      name: 'g1brain_create_ontology_relation_type',
      description: '在领域内创建关系类型定义。sourceType、targetType 为可选类 SID。',
      inputSchema: { type: 'object', properties: {
        collectionName: { type: 'string', minLength: 1 }, domainName: { type: 'string', minLength: 1 },
        sid: { type: 'string', minLength: 1 }, displayName: { type: 'string', minLength: 1 }, description: { type: 'string' },
        sourceType: { type: 'string' }, targetType: { type: 'string' }, relationCategory: { type: 'string' },
        inverseRelationType: { type: 'string' }, symmetric: { type: 'boolean' }, inferable: { type: 'boolean' },
        domains: { type: 'array', items: { type: 'string' } },
      }, required: ['collectionName', 'domainName', 'sid', 'displayName'], additionalProperties: false },
      execute: args => withToolError(async () => {
        const displayName = requiredString(args, 'displayName')
        const description = optionalString(args, 'description')
        return text(await client.createOntologyRelationType(
          requiredString(args, 'collectionName'), requiredString(args, 'domainName'), {
            sid: requiredString(args, 'sid'), displayName,
            labels: { zh: { lang: 'zh', value: displayName } },
            ...(description ? { descriptions: { zh: { lang: 'zh', value: description } } } : {}),
            ...(optionalString(args, 'sourceType') ? { sourceType: optionalString(args, 'sourceType') } : {}),
            ...(optionalString(args, 'targetType') ? { targetType: optionalString(args, 'targetType') } : {}),
            ...(optionalString(args, 'relationCategory') ? { relationCategory: optionalString(args, 'relationCategory') } : {}),
            ...(optionalString(args, 'inverseRelationType') ? { inverseRelationType: optionalString(args, 'inverseRelationType') } : {}),
            ...(optionalBoolean(args, 'symmetric') !== undefined ? { symmetric: optionalBoolean(args, 'symmetric') } : {}),
            ...(optionalBoolean(args, 'inferable') !== undefined ? { inferable: optionalBoolean(args, 'inferable') } : {}),
            ...(optionalStringArray(args, 'domains') ? { domains: optionalStringArray(args, 'domains') } : {}),
          },
        ))
      }),
    },
    {
      name: 'g1brain_update_ontology_relation_type',
      description: '增量更新关系类型的属性值；显示名称请使用重命名工具。',
      inputSchema: { type: 'object', properties: {
        collectionName: { type: 'string', minLength: 1 }, domainName: { type: 'string', minLength: 1 },
        relationSid: { type: 'string', minLength: 1 }, properties: { type: 'object' }, incremental: { type: 'boolean' },
      }, required: ['collectionName', 'domainName', 'relationSid', 'properties'], additionalProperties: false },
      execute: args => withToolError(async () => text(await client.updateOntologyRelationType(
        requiredString(args, 'collectionName'), requiredString(args, 'domainName'), requiredString(args, 'relationSid'),
        optionalObject(args, 'properties') ?? {}, optionalBoolean(args, 'incremental'),
      ))),
    },
    {
      name: 'g1brain_rename_ontology_relation_type',
      description: '修改关系类型的显示名称，不更改关系 SID 或边标签。',
      inputSchema: { type: 'object', properties: {
        collectionName: { type: 'string', minLength: 1 }, domainName: { type: 'string', minLength: 1 },
        relationSid: { type: 'string', minLength: 1 }, newDisplayName: { type: 'string', minLength: 1 },
      }, required: ['collectionName', 'domainName', 'relationSid', 'newDisplayName'], additionalProperties: false },
      execute: args => withToolError(async () => text(await client.renameOntologyRelationType(
        requiredString(args, 'collectionName'), requiredString(args, 'domainName'), requiredString(args, 'relationSid'),
        requiredString(args, 'newDisplayName'),
      ))),
    },
    {
      name: 'g1brain_delete_ontology_relation_type',
      description: '删除一个关系类型定义，不级联删除已有关系边。',
      inputSchema: { type: 'object', properties: {
        collectionName: { type: 'string', minLength: 1 }, domainName: { type: 'string', minLength: 1 }, relationSid: { type: 'string', minLength: 1 },
      }, required: ['collectionName', 'domainName', 'relationSid'], additionalProperties: false },
      execute: args => withToolError(async () => text(await client.deleteOntologyRelationType(
        requiredString(args, 'collectionName'), requiredString(args, 'domainName'), requiredString(args, 'relationSid'),
      ))),
    },
    {
      name: 'g1brain_create_ontology_property',
      description: '创建领域属性定义。',
      inputSchema: { type: 'object', properties: {
        collectionName: { type: 'string', minLength: 1 }, domainName: { type: 'string', minLength: 1 },
        sid: { type: 'string', minLength: 1 }, displayName: { type: 'string', minLength: 1 },
        description: { type: 'string' },
        valueType: { type: 'string', enum: ['STRING', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'DATE', 'DATETIME', 'JSON', 'QUANTITY', 'GEO', 'URL', 'ENTITY_REF', 'PROPERTY_REF', 'MEDIA_REF', 'UNKNOWN'] },
        kind: { type: 'string', enum: ['SCALAR', 'LIST', 'ENTITY', 'TIMESERIES', 'RELATION'] },
        domains: { type: 'array', items: { type: 'string' } },
      }, required: ['collectionName', 'domainName', 'sid', 'displayName', 'valueType', 'kind'], additionalProperties: false },
      execute: args => withToolError(async () => text(await client.createOntologyProperty(requiredString(args, 'collectionName'), requiredString(args, 'domainName'), {
        sid: requiredString(args, 'sid'), displayName: requiredString(args, 'displayName'),
        ...(optionalString(args, 'description') ? { description: optionalString(args, 'description') } : {}),
        valueType: requiredString(args, 'valueType'), kind: requiredString(args, 'kind'),
        ...(optionalStringArray(args, 'domains') ? { domains: optionalStringArray(args, 'domains') } : {}),
      }))),
    },
    {
      name: 'g1brain_update_ontology_property',
      description: '增量更新一个属性定义的属性值；不改变 SID、名称或类型。',
      inputSchema: { type: 'object', properties: {
        collectionName: { type: 'string', minLength: 1 }, domainName: { type: 'string', minLength: 1 },
        propertySid: { type: 'string', minLength: 1 }, properties: { type: 'object' }, incremental: { type: 'boolean' },
      }, required: ['collectionName', 'domainName', 'propertySid', 'properties'], additionalProperties: false },
      execute: args => withToolError(async () => text(await client.updateOntologyProperty(requiredString(args, 'collectionName'), requiredString(args, 'domainName'), requiredString(args, 'propertySid'), optionalObject(args, 'properties') ?? {}, optionalBoolean(args, 'incremental')))),
    },
    {
      name: 'g1brain_delete_ontology_property',
      description: '按属性节点 ID 删除属性定义，不执行级联删除。',
      inputSchema: { type: 'object', properties: {
        collectionName: { type: 'string', minLength: 1 }, domainName: { type: 'string', minLength: 1 }, nodeId: { type: 'string', minLength: 1 },
      }, required: ['collectionName', 'domainName', 'nodeId'], additionalProperties: false },
      execute: args => withToolError(async () => text(await client.deleteOntologyProperty(requiredString(args, 'collectionName'), requiredString(args, 'domainName'), requiredString(args, 'nodeId')))),
    },
    {
      name: 'g1brain_update_ontology_relation',
      description: '按关系 ID 更新关系属性。',
      inputSchema: { type: 'object', properties: {
        collectionName: { type: 'string', minLength: 1 }, domainName: { type: 'string', minLength: 1 },
        relationId: { type: 'string', minLength: 1 }, properties: { type: 'object' }, incremental: { type: 'boolean' },
      }, required: ['collectionName', 'domainName', 'relationId', 'properties'], additionalProperties: false },
      execute: args => withToolError(async () => text(await client.updateOntologyRelation(requiredString(args, 'collectionName'), requiredString(args, 'domainName'), requiredString(args, 'relationId'), optionalObject(args, 'properties') ?? {}, optionalBoolean(args, 'incremental')))),
    },
    // --- Package Validation & Import ---
    {
      name: 'g1brain_validate_ontology_package',
      description: '校验一个本体包 JSON，不会写入线上本体。',
      inputSchema: {
        type: 'object',
        properties: { package: { type: 'object' } },
        required: ['package'],
        additionalProperties: false,
      },
      execute: args => withToolError(async () => text(await client.validateOntologyPackage(args.package))),
    },
    {
      name: 'g1brain_import_ontology_package',
      description: '将本体包写入线上集合。追加导入无需额外确认；replace=true 可能删除已有内容，须传 confirm=true 并通过删除审批。',
      inputSchema: {
        type: 'object',
        properties: {
          collectionName: { type: 'string', minLength: 1 },
          package: { type: 'object' },
          replace: { type: 'boolean' },
          confirm: { type: 'boolean', description: '仅 replace=true 时必需；表示请求替换导入，由 Harness 获取删除审批。' },
        },
        required: ['collectionName', 'package'],
        additionalProperties: false,
      },
      execute: args =>
        withToolError(async () => {
          if (args.replace === true) requiredBoolean(args, 'confirm')
          return text(
            await client.importOntologyPackage(
              requiredString(args, 'collectionName'),
              args.package,
              args.replace === true,
            ),
          )
        }),
    },
    {
      name: 'g1brain_list_agents',
      description: '列出 G1brain 智能体配置。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: () => withToolError(async () => text(await client.listAgents())),
    },
    {
      name: 'g1brain_get_agent',
      description: '获取指定 G1brain 智能体的详细配置。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', minLength: 1 } },
        required: ['id'],
        additionalProperties: false,
      },
      execute: args =>
        withToolError(async () => text(await client.getAgent(requiredString(args, 'id')))),
    },
    {
      name: 'g1brain_create_agent',
      description: '创建一个 G1brain 智能体配置，支持关联知识库、本体、提示词等。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, description: '智能体名称' },
          description: { type: 'string', description: '智能体简介' },
          prompt: { type: 'string', description: '智能体人设提示词/指令' },
          promptTemplate: { type: 'string', description: '指令模板（与 prompt 等效）' },
          modelId: { type: 'string', description: '使用的模型标识' },
          model: { type: 'string', description: '使用的模型标识（与 modelId 等效）' },
          collection: { type: 'string', description: '关联的文档库名称' },
          ontology: { type: 'string', description: '关联的本体集合名称' },
          docs: { type: 'array', items: { type: 'string' }, description: '关联的文档列表' },
          skills: { type: 'array', description: '关联的技能列表' },
          mcp: { type: 'array', description: '关联的 MCP 服务配置' },
          capabilities: { type: 'array', description: '启用的功能特性' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      execute: args =>
        withToolError(async () => {
          const name = requiredString(args, 'name')
          const prompt = optionalString(args, 'prompt') ?? optionalString(args, 'promptTemplate') ?? ''
          const model = optionalString(args, 'model') ?? optionalString(args, 'modelId') ?? 'deepseek-chat'
          const description = optionalString(args, 'description')
          const collection = optionalString(args, 'collection')
          const ontology = optionalString(args, 'ontology')
          const docs = Array.isArray(args.docs) ? args.docs : undefined
          const skills = Array.isArray(args.skills) ? args.skills : undefined
          const mcp = Array.isArray(args.mcp) ? args.mcp : undefined
          const capabilities = Array.isArray(args.capabilities) ? args.capabilities : undefined

          return text(
            await client.createAgent({
              name,
              description,
              prompt,
              promptTemplate: prompt,
              model,
              modelId: model,
              collection,
              ontology,
              docs,
              skills,
              mcp,
              capabilities,
            }),
          )
        }),
    },
    {
      name: 'g1brain_update_agent',
      description: '更新一个已存在的 G1brain 智能体配置。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, description: '智能体 ID' },
          name: { type: 'string', description: '智能体名称' },
          description: { type: 'string', description: '智能体简介' },
          prompt: { type: 'string', description: '智能体人设提示词/指令' },
          promptTemplate: { type: 'string', description: '指令模板（与 prompt 等效）' },
          modelId: { type: 'string', description: '使用的模型标识' },
          model: { type: 'string', description: '使用的模型标识（与 modelId 等效）' },
          collection: { type: 'string', description: '关联的文档库名称' },
          ontology: { type: 'string', description: '关联的本体集合名称' },
          docs: { type: 'array', items: { type: 'string' }, description: '关联的文档列表' },
          skills: { type: 'array', description: '关联的技能列表' },
          mcp: { type: 'array', description: '关联的 MCP 服务配置' },
          capabilities: { type: 'array', description: '启用的功能特性' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      execute: args =>
        withToolError(async () => {
          const id = requiredString(args, 'id')
          const payload: Record<string, unknown> = {}
          if (typeof args.name === 'string') payload.name = args.name.trim()
          if (typeof args.description === 'string') payload.description = args.description.trim()
          const prompt = optionalString(args, 'prompt') ?? optionalString(args, 'promptTemplate')
          if (prompt !== undefined) {
            payload.prompt = prompt
            payload.promptTemplate = prompt
          }
          const model = optionalString(args, 'model') ?? optionalString(args, 'modelId')
          if (model !== undefined) {
            payload.model = model
            payload.modelId = model
          }
          if (typeof args.collection === 'string') payload.collection = args.collection.trim()
          if (typeof args.ontology === 'string') payload.ontology = args.ontology.trim()
          if (Array.isArray(args.docs)) payload.docs = args.docs
          if (Array.isArray(args.skills)) payload.skills = args.skills
          if (Array.isArray(args.mcp)) payload.mcp = args.mcp
          if (Array.isArray(args.capabilities)) payload.capabilities = args.capabilities

          return text(await client.updateAgent(id, payload))
        }),
    },
    {
      name: 'g1brain_publish_agent',
      description: '发布一个 G1brain 智能体；必须显式传入 confirm=true。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', minLength: 1 }, confirm: { type: 'boolean' } },
        required: ['id', 'confirm'],
        additionalProperties: false,
      },
      execute: args =>
        withToolError(async () => {
          requiredBoolean(args, 'confirm')
          return text(await client.publishAgent(requiredString(args, 'id')))
        }),
    },
  ]
}

/** Reject an unsafe relative materials path before filesystem access.
 * @param path - model-supplied relative path.
 */
export function assertScopePath(path: string): void {
  if (path.startsWith('/') || path.includes('..')) throw new ScopeError('工具路径必须是安全的相对路径', path)
}
