/** Private access-token synchronization and renewal requests; refresh tokens never enter this process. */
import type { Context } from '@deepseek-ai/cordis'
import type G1brainIntegration from '@deepseek-ai/dsh-g1brain-integration'
import type { G1brainAccessCredential, G1brainRefreshResult } from '@deepseek-ai/dsh-g1brain-integration/types'

/** Only the parent/child IPC operations used by the authentication bridge. */
export interface G1brainAuthenticationChannel {
  readonly connected?: boolean
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'disconnect', listener: () => void): unknown
  off(event: 'message', listener: (message: unknown) => void): unknown
  off(event: 'disconnect', listener: () => void): unknown
  send?(message: object, callback: (error: Error | null) => void): boolean | void
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function credential(value: unknown): value is G1brainAccessCredential {
  return record(value) && typeof value.accessToken === 'string' && value.accessToken.length > 0 && value.accessToken.length <= 65536
    && !/[\u0000-\u001f\u007f]/u.test(value.accessToken)
    && typeof value.userId === 'string' && value.userId.length > 0 && value.userId.length <= 1024
    && !/[\u0000-\u001f\u007f]/u.test(value.userId)
    && typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision > 0
    && (value.expiresAt === undefined || (typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt) && value.expiresAt > 0))
}
function result(value: unknown): value is G1brainRefreshResult {
  return record(value) && (value.kind === 'expired' || value.kind === 'unavailable'
    || (value.kind === 'updated' && credential(value.credential)))
}

/** Bind the current G1brain provider to private main-process renewal and access-only pushes.
 * @param ctx - owning Host lifetime, including replacement of the G1brain plugin.
 * @param channel - parent IPC transport; injectable without exposing a renderer operation.
 */
export function installG1brainAuthentication(ctx: Context, channel: G1brainAuthenticationChannel = process): void {
  ctx.effect(() => {
    let active = true
    let nextId = 1
    let latest: G1brainAccessCredential | undefined
    let service: G1brainIntegration | undefined
    let connection: ReturnType<G1brainIntegration['connectAuthentication']> | undefined
    const pending = new Map<number, { resolve: (value: G1brainRefreshResult) => void; timer: ReturnType<typeof setTimeout> }>()
    const settle = (id: number, value: G1brainRefreshResult): void => {
      const request = pending.get(id)
      if (!request) return
      pending.delete(id)
      clearTimeout(request.timer)
      request.resolve(value)
    }
    const disconnected = (): void => { for (const id of pending.keys()) settle(id, { kind: 'unavailable' }) }
    const refresh = (rejectedAccessToken?: string): Promise<G1brainRefreshResult> => {
      if (!active || !channel.connected || !channel.send) return Promise.resolve({ kind: 'unavailable' })
      const requestId = nextId++
      return new Promise((resolve) => {
        const timer = setTimeout(() => { settle(requestId, { kind: 'unavailable' }) }, 30000)
        pending.set(requestId, { resolve, timer })
        try {
          channel.send?.({ type: 'g1brain-auth-refresh', requestId,
            ...(rejectedAccessToken === undefined ? {} : { rejectedAccessToken }) }, (error) => {
            if (error !== null) settle(requestId, { kind: 'unavailable' })
          })
        } catch (_closedChannel: unknown) { settle(requestId, { kind: 'unavailable' }) }
      })
    }
    const bind = (): void => {
      if (!active) return
      const next = ctx.get('g1brain') as G1brainIntegration | undefined
      if (next === service) return
      connection?.dispose()
      service = next
      connection = next?.connectAuthentication(refresh)
      if (latest) connection?.update(latest)
    }
    const update = (next: G1brainAccessCredential): boolean => {
      if (latest && next.revision <= latest.revision) return true
      try { connection?.update(next) }
      catch (_rejectedCredential: unknown) {
        ctx.logger('desktop-g1brain').warn('Access credential update rejected')
        return false
      }
      latest = next
      return true
    }
    const message = (value: unknown): void => {
      if (!active || !record(value)) return
      if (value.type === 'g1brain-auth-update' && credential(value.credential)) {
        update(value.credential)
      } else if (value.type === 'g1brain-auth-refreshed' && typeof value.requestId === 'number' && result(value.result)) {
        if (value.result.kind === 'updated') {
          if (!update(value.result.credential)) { settle(value.requestId, { kind: 'unavailable' }); return }
        }
        settle(value.requestId, value.result)
      }
    }
    channel.on('message', message)
    channel.on('disconnect', disconnected)
    const unwatch = ctx.on('internal/service', (name) => {
      if (name === 'g1brain') queueMicrotask(() => {
        try { bind() } catch (_rebindFailed: unknown) { ctx.logger('desktop-g1brain').warn('Authentication provider rebinding failed') }
      })
    })
    bind()
    return () => {
      active = false
      unwatch()
      channel.off('message', message)
      channel.off('disconnect', disconnected)
      connection?.dispose()
      disconnected()
    }
  })
}
