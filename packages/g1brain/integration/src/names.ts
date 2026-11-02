/** Stable ASCII resource identifiers and reserved ontology-domain checks. */
import { createHash } from 'node:crypto'

/** Accepted identifiers for newly created classes, instances, properties and relation types. */
export const NEW_SID_PATTERN = '^[A-Za-z][A-Za-z0-9_]*$'

/** Model-visible naming rule; existing references retain their original identifiers. */
export const NEW_SID_DESCRIPTION = '新建 SID 必须以英文字母开头，仅含英文字母、数字、下划线，例如 Instrument、belongs_to_unit；不要拼接 collection/domain 前缀，不含点号、连字符、空格或中文。中文名称填写 displayName。已有 SID 引用须保持原值。'

/** Validate a new ontology identifier without renaming it or changing existing references.
 * @param value - untrusted identifier supplied for creation.
 * @param field - argument name shown in a validation error.
 * @returns the unchanged identifier; invalid identifiers throw before any request.
 */
export function requireNewSid(value: unknown, field = 'sid'): string {
  if (typeof value !== 'string' || value !== value.trim() || !new RegExp(NEW_SID_PATTERN).test(value)) {
    throw new Error(`${field} 格式无效。${NEW_SID_DESCRIPTION}`)
  }
  return value
}

/** Reject relation labels known to fail at the graph edge endpoint.
 * @param value - definition display name or its SID when no display name exists.
 * @returns the unchanged label, or throws without attempting a write.
 */
export function requireRelationLabel(value: string): string {
  if (!value.trim() || /[.\p{Cc}]/u.test(value)) {
    throw new Error('关系显示名不能包含点号或控制字符，且不能为空；当前服务无法用此名称写入关系边。请修正关系显示名，勿改写已有 SID 或盲目重试。')
  }
  return value
}

/** Recognize internal domains that cannot be selected as business write targets.
 * @param value - API domain name, not its display label.
 * @returns whether the name identifies a reserved schema or shared domain.
 */
export function isSystemDomain(value: string): boolean {
  return /^(?:_?schema|_?shared?)$/iu.test(value.trim())
}

/** Resolve a new resource name without changing existing resource references.
 * @param value - requested API name or user-entered display name.
 * @param kind - generated identifier prefix.
 * @param seed - Session identity for repeatable, independently scoped names.
 * @returns a conservative ASCII identifier; already valid identifiers remain unchanged.
 */
export function resourceName(value: string, kind: 'col' | 'dom', seed = ''): string {
  const clean = value.trim()
  if (!clean) throw new Error('G1brain resource name must not be blank')
  if (/^[a-z][a-z0-9_]{0,47}$/u.test(clean) && !isSystemDomain(clean)) return clean
  return `${kind}_${createHash('sha256').update(JSON.stringify([seed, kind, clean])).digest('hex').slice(0, 24)}`
}

/** Reject invalid technical names before sending a creation request.
 * @param value - resolved collection or domain identifier.
 * @returns the unchanged identifier when valid.
 */
export function requireResourceName(value: string): string {
  if (resourceName(value, 'col') !== value) throw new Error('G1brain API name must start with a lowercase letter and contain only lowercase letters, digits or underscores (maximum 48 characters); use displayName for a user-facing name')
  return value
}
