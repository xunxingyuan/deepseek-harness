function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate legacy constraints omitted from Harness's model-facing JSON Schema subset.
 * @param schema - original input schema.
 * @param value - untrusted tool arguments or a nested value.
 * @param path - human-readable argument path for errors.
 */
export function validateInput(schema: Record<string, unknown>, value: unknown, path = 'arguments'): void {
  const type = schema.type
  if (type === 'object') {
    if (!object(value)) throw new Error(`${path} 必须是对象`)
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
    for (const key of (schema.required ?? []) as string[]) if (!(key in value)) throw new Error(`${path}.${key} 为必填项`)
    for (const [key, child] of Object.entries(value)) {
      if (!(key in properties)) {
        if (schema.additionalProperties === false) throw new Error(`${path}.${key} 不是允许的参数`)
        if (object(schema.additionalProperties)) validateInput(schema.additionalProperties, child, `${path}.${key}`)
      } else {
        const property = properties[key]
        if (property === undefined) throw new Error(`${path}.${key} 不是允许的参数`)
        validateInput(property, child, `${path}.${key}`)
      }
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path} 必须是数组`)
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) throw new Error(`${path} 元素数量不足`)
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) throw new Error(`${path} 元素数量过多`)
    if (object(schema.items)) value.forEach((item, i) => { validateInput(schema.items as Record<string, unknown>, item, `${path}[${i}]`) })
  } else if (type === 'string') {
    if (typeof value !== 'string') throw new Error(`${path} 必须是字符串`)
    if (typeof schema.minLength === 'number' && value.trim().length < schema.minLength) throw new Error(`${path} 不能为空`)
    if (typeof schema.pattern === 'string' && !(new RegExp(schema.pattern).test(value))) throw new Error(`${path} 格式无效`)
  } else if (type === 'integer') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${path} 必须是整数`)
  } else if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path} 必须是有限数字`)
  } else if (type === 'boolean' && typeof value !== 'boolean') throw new Error(`${path} 必须是布尔值`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new Error(`${path} 不在允许值内`)
  if ('const' in schema && value !== schema.const) throw new Error(`${path} 必须为 ${String(schema.const)}`)
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) throw new Error(`${path} 小于最小值`)
    if (typeof schema.maximum === 'number' && value > schema.maximum) throw new Error(`${path} 大于最大值`)
  }
}
