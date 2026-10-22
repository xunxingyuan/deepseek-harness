/** Model-facing Excel routing and table-query operations for one bound G1brain Session. */
import { Buffer } from 'node:buffer'
import type { ToolDefinition } from '../legacy/bridge/tools.ts'
import { MaterialRouter } from './router.ts'
import { isObject } from './client.ts'

function text(value: unknown) {
  const result = JSON.stringify(value)
  if (Buffer.byteLength(result, 'utf8') > 32 * 1024) throw new Error('表格查询结果超过 32 KiB，请分批查看文件或缩小 SQL 查询范围')
  return { content: [{ type: 'text' as const, text: result }] }
}

function string(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} 须为非空字符串`)
  return value
}

function files(args: Record<string, unknown>): string[] {
  const value = args.files
  if (!Array.isArray(value)) throw new Error('files 须明确列出所选目录内的相对路径')
  return value.map((item: unknown) => {
    if (typeof item !== 'string') throw new Error('文件路径须为字符串')
    return item
  })
}

/** Build fixed, collection-scoped operations without exposing generic REST or write MCP access.
 * @param router - bound Session material router.
 * @returns read-only analysis and table tools; upload remains the existing material-upload tool.
 */
export function createTableTools(router: MaterialRouter): ToolDefinition[] {
  const define = (name: string, description: string, properties: Record<string, unknown>, required: readonly string[],
    run: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>): ToolDefinition => ({
    name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
    execute: async (args, signal) => {
      try { return text(await run(args, signal)) }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] } }
    },
  })
  const dataset = { type: 'string', minLength: 1, description: '从当前领域表格目录读取的 dataset_id，不能使用显示名或 SQL 表名。' }
  return [
    define('g1brain_inspect_materials', '只读预检所选文件。Excel 按工作表判断规整表格或说明内容，返回分流原因；不上传、不创建集合。含不规则表头/合并区域/未计算公式的工作表保留为文档，解析失败明确报错。',
      { files: { type: 'array', items: { type: 'string', minLength: 1 }, description: '1～20 个不重复的所选目录内相对路径。' } }, ['files'], args => router.inspect(files(args))),
    define('g1brain_table_context', '读取当前本体领域绑定的表格集合 ID 和名称，不创建集合，不改查其他领域。', {}, [], (_args, signal) => router.context(signal)),
    define('g1brain_list_data_tables', '列出当前本体领域绑定集合中的数据表、真实 SQL 表名和行数。不接受其他集合参数。', {}, [], (_args, signal) => router.read('list_tables', {}, signal)),
    define('g1brain_describe_data_table', '读取当前领域数据表的真实字段名、显示名和字段类型。SQL 必须使用真实表名和字段名，不用 Excel 显示名称代替。',
      { dataset_id: dataset }, ['dataset_id'], (args, signal) => router.read('describe_table', { dataset_id: string(args, 'dataset_id') }, signal)),
    define('g1brain_preview_data_table', '预览当前领域数据表的少量记录，不能用预览行数推算总计。精确统计请使用 SQL 聚合。',
      { dataset_id: dataset, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['dataset_id'],
      (args, signal) => router.read('preview_table', { dataset_id: string(args, 'dataset_id'), ...(args.limit === undefined ? {} : { limit: args.limit }) }, signal)),
    define('g1brain_query_data_tables', '在当前领域绑定的表格集合内执行单条只读 SELECT，可聚合或 JOIN。先列目录并读取字段；按返回的 database 方言使用真实 SQL 表名。返回最多 200 行；保留大整数和精确小数字符串，不转换成浮点数。',
      { sql: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['sql'],
      (args, signal) => router.read('query_tables', { sql: string(args, 'sql'), ...(args.limit === undefined ? {} : { limit: args.limit }) }, signal)),
    define('g1brain_get_table_imports', '查询当前领域上传回执中的表格导入任务。只有 completed 才表示导入完成；partial、failed、needs_input 或未找到任务均不能宣称成功，也不能盲目重传。表格导入任务不是向量文档库的 MD/CHUNK 任务。',
      {}, [], (_args, signal) => router.imports(signal)),
    define('g1brain_preview_table_headers', '预览当前领域导入任务中缺失的表头及候选行，先核对样例再补齐；不修改数据。', {
      job_id: { type: 'string', minLength: 1 }, sheet: { type: 'string', minLength: 1 },
      header_row: { type: 'integer', minimum: 1, maximum: 1000 },
    }, ['job_id', 'sheet'], (args, signal) => router.headerPreview(string(args, 'job_id'), string(args, 'sheet'),
      typeof args.header_row === 'number' ? args.header_row : undefined, signal)),
    define('g1brain_fill_table_headers', '仅为当前领域的 needs_input/partial 导入任务补齐明确的缺失表头，然后继续轮询导入状态。不支持舍弃列，不得臆造不明字段含义。先读取表头预览，含义不明确时向用户澄清。', {
      job_id: { type: 'string', minLength: 1 }, sheet: { type: 'string', minLength: 1 },
      header_row: { type: 'integer', minimum: 1, maximum: 1000 }, headers: { type: 'object', additionalProperties: { type: 'string' } },
    }, ['job_id', 'sheet', 'header_row', 'headers'], (args, signal) => {
      if (!isObject(args.headers) || typeof args.header_row !== 'number') throw new Error('缺失表头参数无效')
      const headers: Record<string, string> = {}
      const entries = Object.entries(args.headers)
      if (!entries.length || entries.length > 200) throw new Error('每次须补齐 1～200 个缺失列名')
      for (const [index, name] of entries) {
        if (!/^[1-9]\d{0,2}$/u.test(index) || Number(index) > 200 || typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('缺失列索引或列名无效')
        headers[index] = name.trim()
      }
      return router.fillHeaders(string(args, 'job_id'), string(args, 'sheet'), args.header_row, headers, signal)
    }),
  ]
}
