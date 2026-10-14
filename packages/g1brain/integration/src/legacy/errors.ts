/** G1brain REST or business-response failure with optional response details. */
export class G1BrainError extends Error {
  /** HTTP or business status, when available. */
  readonly status: number | undefined
  /** Request path that failed, when available. */
  readonly path: string | undefined
  /** Untrusted backend response body, retained for diagnostics. */
  readonly response: unknown

  constructor(message: string, options: { status?: number; path?: string; response?: unknown } = {}) {
    super(message)
    this.name = 'G1BrainError'
    this.status = options.status
    this.path = options.path
    this.response = options.response
  }
}

/** Earlier client workflow failure; retained for migrated callers. */
export class HarnessError extends Error {
  /** Stable earlier-client error code, when available. */
  readonly code: string | undefined
  /** Additional failure context, when available. */
  readonly details: unknown

  constructor(message: string, options: { code?: string; details?: unknown } = {}) {
    super(message)
    this.name = 'HarnessError'
    this.code = options.code
    this.details = options.details
  }
}

/** Materials path or file policy violation. */
export class ScopeError extends Error {
  /** Rejected path, when available. */
  readonly path: string | undefined

  constructor(message: string, path?: string) {
    super(message)
    this.name = 'ScopeError'
    this.path = path
  }
}
