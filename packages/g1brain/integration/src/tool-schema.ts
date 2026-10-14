/** Adapt legacy validation keywords to Harness's supported model schema subset. */
import { assertSupportedJsonSchema, type JsonSchemaNode } from '@deepseek-ai/dsh-tools'

const VALIDATED_AT_EXECUTION = new Set(['minLength', 'minimum', 'maximum', 'pattern'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function modelSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(modelSchema)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !VALIDATED_AT_EXECUTION.has(key))
    .map(([key, child]) => [key, key === 'additionalProperties' && isRecord(child) ? true : modelSchema(child)]))
}

/** Retain model-understood schema fields while execution enforces every original constraint.
 * @param legacy - original G1brain tool schema, including stricter validation keywords.
 * @returns a Harness-compatible schema with the original argument structure.
 */
export function toHarnessToolSchema(legacy: Record<string, unknown>): JsonSchemaNode & Record<string, unknown> {
  const schema = modelSchema(legacy)
  assertSupportedJsonSchema(schema)
  if (!isRecord(schema) || schema.type !== 'object') throw new Error('G1brain tool parameters must be object-rooted')
  return schema
}
