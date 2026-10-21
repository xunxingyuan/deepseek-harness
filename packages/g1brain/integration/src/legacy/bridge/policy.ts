import type { PreparedTask } from '../types.ts'
import { isSystemDomain } from '../../names.ts'

/** G1brain operations that require write access to the bound resources. */
export const MUTATING_TOOLS = new Set([
  'g1brain_create_document_library', 'g1brain_upload_selected_files',
  'g1brain_submit_document_task', 'g1brain_cancel_document_task',
  'g1brain_create_ontology_collection', 'g1brain_create_ontology_domain',
  'g1brain_create_ontology_entity', 'g1brain_update_ontology_entity',
  'g1brain_create_ontology_relation', 'g1brain_delete_ontology_relation',
  'g1brain_update_ontology_relation', 'g1brain_create_ontology_property',
  'g1brain_update_ontology_property', 'g1brain_delete_ontology_property',
  'g1brain_delete_ontology_entity', 'g1brain_create_ontology_relation_type',
  'g1brain_update_ontology_relation_type', 'g1brain_rename_ontology_relation_type',
  'g1brain_delete_ontology_relation_type',
  'g1brain_import_ontology_package', 'g1brain_create_agent',
  'g1brain_update_agent', 'g1brain_publish_agent',
])

/** Explicit deletion tools whose calls each need a human approval. */
export const DELETION_TOOLS = new Set([
  'g1brain_delete_ontology_entity', 'g1brain_delete_ontology_relation',
  'g1brain_delete_ontology_property', 'g1brain_delete_ontology_relation_type',
])

/** Determine whether a call can delete existing G1brain data.
 * @param name - exact registered tool name.
 * @param args - validated arguments, including the package replacement switch.
 * @returns true for explicit deletions or replacement imports.
 */
export function requiresDeletionApproval(name: string, args: Record<string, unknown>): boolean {
  return DELETION_TOOLS.has(name) || (name === 'g1brain_import_ontology_package' && args.replace === true)
}

/** Preserve legacy confirmation arguments while requiring them only for deletions.
 * @param schema - original legacy tool input schema.
 * @param mutating - whether the tool changes remote state.
 * @param deletion - whether this tool always deletes existing data.
 * @returns a write schema with optional compatibility confirmation or required deletion intent.
 */
export function scopedSchema(schema: Record<string, unknown>, mutating: boolean, deletion = false): Record<string, unknown> {
  if (!mutating) return schema
  const properties = schema.properties as Record<string, unknown>
  return {
    ...schema,
    properties: { ...properties, confirm: deletion
      ? { type: 'boolean', const: true, description: '标记此次删除请求；用户授权由 Harness 审批取得，无需先单独发起聊天确认。' }
      : properties.confirm ?? { type: 'boolean', description: '兼容旧会话参数；新增和非删除修改无需用户确认。' } },
    required: [...new Set([...(schema.required as string[] | undefined ?? []), ...(deletion ? ['confirm'] : [])])],
  }
}

function oneOf(name: string, actual: unknown, allowed: Array<string | undefined>): void {
  if (typeof actual !== 'string' || !allowed.filter(Boolean).includes(actual.trim())) {
    throw new Error(`${name} 不在当前任务授权范围内`)
  }
}

/** Reject a tool call outside the targets selected for its Session.
 * @param task - persisted Session binding, absent only for unmanaged legacy MCP use.
 * @param tool - exact G1brain tool name.
 * @param args - validated model arguments.
 */
export function assertTaskScope(task: PreparedTask | undefined, tool: string, args: Record<string, unknown>): void {
  if (MUTATING_TOOLS.has(tool) && ((typeof args.domainName === 'string' && isSystemDomain(args.domainName))
    || (tool === 'g1brain_create_ontology_domain' && typeof args.name === 'string' && isSystemDomain(args.name))
    || (Array.isArray(args.domains) && args.domains.some(domain => typeof domain === 'string' && isSystemDomain(domain))))) {
    throw new Error('系统领域不能作为本体新增或优化的写入目标')
  }
  if (!task) return // Standalone stdio MCP is configured directly by its operator.
  if (tool === 'g1brain_update_agent' || tool === 'g1brain_publish_agent') {
    throw new Error('当前本体任务未绑定智能体 ID，不能修改或发布任意智能体')
  }
  if (tool === 'g1brain_create_agent') {
    if (args.ontology === undefined && args.collection === undefined) throw new Error('智能体必须关联当前任务的本体集合或文档库')
    if (args.ontology !== undefined) oneOf('本体集合', args.ontology, [task.ontologyCollectionName, task.createOntologyCollectionName])
    if (args.collection !== undefined) oneOf('文档库', args.collection, [task.documentLibraryName, task.createDocumentLibraryName])
  }
  if (tool === 'g1brain_create_document_library') oneOf('文档库', args.name, [task.createDocumentLibraryName])
  else if ('collectionName' in args && /document|selected_files|hybrid_search|qa_search/.test(tool)) {
    oneOf('文档库', args.collectionName, [task.documentLibraryName, task.createDocumentLibraryName])
  }
  if (tool === 'g1brain_create_ontology_collection') {
    oneOf('本体集合', args.name, [task.createOntologyCollectionName])
    return
  }
  if ((!tool.includes('ontology') && tool !== 'g1brain_list_entity_taxonomy_nodes') || tool === 'g1brain_list_ontology_collections' || tool === 'g1brain_validate_ontology_package') return
  oneOf('本体集合', args.collectionName, [task.ontologyCollectionName, task.createOntologyCollectionName])
  const ownsNewCollection = args.collectionName === task.createOntologyCollectionName
  if (tool === 'g1brain_create_ontology_domain') {
    if (task.createDomainName || !ownsNewCollection) oneOf('领域', args.name, [task.createDomainName])
    return
  }
  if (tool === 'g1brain_export_ontology_package') {
    const allowed = [task.domainName, task.createDomainName].filter(Boolean)
    if ((!ownsNewCollection || allowed.length > 0) && (!Array.isArray(args.domains)
      || args.domains.length === 0 || args.domains.some(d => !allowed.includes(d as string)))) {
      throw new Error('导出范围必须明确限定为当前任务的领域')
    }
    return
  }
  if (tool === 'g1brain_import_ontology_package') {
    if (!task.createOntologyCollectionName || args.collectionName !== task.createOntologyCollectionName) {
      throw new Error('现有集合禁止通过任务工具执行整包导入；请使用细粒度写入工具')
    }
    const pkg = args.package as Record<string, unknown>
    const targets = pkg.targets as Record<string, unknown> | undefined
    const collection = targets?.collection as Record<string, unknown> | undefined
    if (collection?.defaultName && collection.defaultName !== args.collectionName) throw new Error('本体包默认集合与当前任务不一致')
    const domains = targets?.domains
    const allowed = [task.domainName, task.createDomainName].filter(Boolean)
    if (allowed.length > 0 && (!Array.isArray(domains) || domains.length === 0 || domains.some(d => typeof d !== 'object' || !d || !allowed.includes((d as Record<string, unknown>).name as string)))) {
      throw new Error('本体包领域未明确限定为当前任务的领域')
    }
    return
  }
  if ('domainName' in args && (!ownsNewCollection || task.domainName || task.createDomainName)) oneOf('领域', args.domainName, [task.domainName, task.createDomainName])
  if (['g1brain_create_ontology_property', 'g1brain_create_ontology_relation_type'].includes(tool) && Array.isArray(args.domains) && (!ownsNewCollection || task.domainName || task.createDomainName)) {
    for (const domain of args.domains) oneOf('定义适用领域', domain, [task.domainName, task.createDomainName])
  }
}
