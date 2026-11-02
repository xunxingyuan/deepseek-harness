/** Scripted model and human approval for the real G1brain Session workflow. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-user-approval'

const legacyCalls = [
  { name: 'g1brain_list_selected_files', args: {} },
  { name: 'g1brain_read_selected_file', args: { path: '第一张表.md' } },
  { name: 'g1brain_read_selected_file', args: { path: '中文 Word.docx' } },
  { name: 'g1brain_read_selected_file', args: { path: '中文 Excel.xlsx' } },
  { name: 'g1brain_create_ontology_collection', args: { name: 'col_7c120e3057d72928f5491e86' } },
  { name: 'g1brain_create_ontology_domain', args: { collectionName: 'col_7c120e3057d72928f5491e86', name: 'dom_e4d35bcec9eb3d594c4bdeb7' } },
  { name: 'g1brain_create_document_library', args: { name: '周报文档库' } },
  { name: 'g1brain_upload_selected_files', args: { collectionName: '周报文档库', files: ['中文 Word.docx', '中文 Excel.xlsx'] } },
  { name: 'g1brain_delete_ontology_property', args: { collectionName: 'col_7c120e3057d72928f5491e86', domainName: 'dom_e4d35bcec9eb3d594c4bdeb7', nodeId: 'obsolete-property', confirm: true } },
] as const

const tableCalls = [
  ...legacyCalls.slice(0, 7),
  { name: 'g1brain_inspect_materials', args: { files: ['混合数据.xlsx'] } },
  { name: 'g1brain_upload_selected_files', args: { files: ['混合数据.xlsx'] } },
  { name: 'g1brain_table_context', args: {} },
  { name: 'g1brain_list_data_tables', args: {} },
  { name: 'g1brain_describe_data_table', args: { dataset_id: 'data-test' } },
  { name: 'g1brain_query_data_tables', args: { sql: 'SELECT SUM(output) AS total FROM data_test' } },
  { name: 'g1brain_get_table_imports', args: {} },
] as const

const sidTarget = { collectionName: 'col_7c120e3057d72928f5491e86', domainName: 'dom_e4d35bcec9eb3d594c4bdeb7' }
const sidCalls = [
  ...legacyCalls.slice(0, 7),
  { name: 'g1brain_create_ontology_property', args: { ...sidTarget, sid: 'domain.invalid', displayName: '拒绝的属性', kind: 'SCALAR', valueType: 'STRING' } },
  { name: 'g1brain_create_ontology_property', args: { ...sidTarget, sid: 'tag_number', displayName: '位号', kind: 'SCALAR', valueType: 'STRING' } },
  { name: 'g1brain_create_ontology_relation_type', args: { ...sidTarget, sid: 'belongs_to_unit', displayName: '属于单元' } },
  { name: 'g1brain_create_ontology_relation', args: { ...sidTarget, fromSid: 'legacy.Source', toSid: 'legacy.Target', relationSid: 'belongs_to_unit' } },
  { name: 'g1brain_create_ontology_relation', args: { ...sidTarget, fromSid: 'legacy.Source', toSid: 'legacy.Target', relationSid: 'legacy.contains' } },
] as const

class WorkflowAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const tables = process.env.G1BRAIN_TEST_TABLES === '1'
    const sidMode = process.env.G1BRAIN_TEST_SID === '1'
    const calls = sidMode ? sidCalls : tables ? tableCalls : legacyCalls
    const tools = options.tools ?? []
    for (const call of calls) {
      if (!tools.some(tool => tool.name === call.name)) throw new Error(`G1brain workflow tool missing: ${call.name}`)
    }
    const text = options.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
    if (!text.includes('Use Simplified Chinese for Chinese requests')) throw new Error('G1brain reply-language guidance missing')
    if (!text.includes('without asking for extra confirmation')) throw new Error('G1brain automatic non-deletion policy missing')
    if (!text.includes('Do not prefix a SID with the collection or domain')) throw new Error('G1brain SID guidance missing')
    const completed = options.messages.filter(message => message.role === 'tool').length
    if (completed >= 2 && !text.includes('G1BRAIN_WINDOWS_MATERIAL_EVIDENCE')) throw new Error('Chinese materials file was not read')
    if (completed >= 3 && !text.includes('生产周报：中文正文')) throw new Error('Word Chinese text was not extracted')
    if (completed >= 4 && !text.includes('二号炉例行检查')) throw new Error('Excel Chinese sheets were not extracted')
    const call = calls[completed]
    if (call !== undefined) {
      const id = ToolCallId(`g1brain-workflow-${completed}`)
      const args = JSON.stringify(call.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: call.name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: call.name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (tables && completed >= tableCalls.length && (!text.includes('215') || !text.includes('completed'))) throw new Error('Table evidence missing')
    if (sidMode && !text.includes('格式无效')) throw new Error('Unsafe SID was not rejected in the Session')
    const answer = sidMode ? '已拒绝不合规新 SID，普通 SID 与旧关系 SID 均按显示名写入。'
      : tables ? '已分流 Excel：数据表导入完成，说明进入文档库；SQL 总产量为 215。'
        : '已读取中文材料并直接创建周报本体、领域和文档库；废弃属性经审批后删除。'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: answer }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'g1brain-workflow-model'
export const inject = ['llm', 'approval']

/** Supply deterministic responses and the external user's approval in this fixture. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['g1brain-workflow-fixture'], new WorkflowAdapter())
  ctx.on('approval/request', async (request, next) => {
    if (request.agent?.id !== 'session-g1brain-workflow') return next()
    if (request.toolName !== 'g1brain_delete_ontology_property') throw new Error('Non-deletion unexpectedly requested approval')
    return 'allowed-once'
  })
}
