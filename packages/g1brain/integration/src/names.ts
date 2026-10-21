/** Stable ASCII resource identifiers and reserved ontology-domain checks. */
import { createHash } from 'node:crypto'

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
