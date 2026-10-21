/** Scripted model and human approval for the real G1brain Session workflow. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-user-approval'

const calls = [
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

class WorkflowAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const tools = options.tools ?? []
    for (const call of calls) {
      if (!tools.some(tool => tool.name === call.name)) throw new Error(`G1brain workflow tool missing: ${call.name}`)
    }
    const text = options.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
    if (!text.includes('Use Simplified Chinese for Chinese requests')) throw new Error('G1brain reply-language guidance missing')
    if (!text.includes('without asking for extra confirmation')) throw new Error('G1brain automatic non-deletion policy missing')
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
    const answer = '已读取中文材料并直接创建周报本体、领域和文档库；废弃属性经审批后删除。'
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
