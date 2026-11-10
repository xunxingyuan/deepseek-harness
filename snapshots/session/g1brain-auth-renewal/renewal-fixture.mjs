/** External catalog and private credential-owner fixtures; the real G1brain tool handles renewal. */
import { writeFileSync } from 'node:fs'

export const name = 'g1brain-renewal-fixture'

/** Install only scenario-owned HTTP responses and a renewal callback, then detach both with the fiber. */
export function apply(ctx) {
  let renewed = false
  let rejected = false
  let requests = 0
  ctx.effect(() => {
    const original = globalThis.fetch
    const fixtureFetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url !== 'http://127.0.0.1:1/kgApi/v1/gs/collections') return original(input, init)
      const headers = new Headers(init?.headers)
      requests++
      if (!renewed && !rejected && headers.get('Blade-Auth') === 'bearer snapshot-access-old') {
        rejected = true
        return Response.json({ code: 401 }, { status: 401 })
      }
      if (!renewed || headers.get('Blade-Auth') !== 'bearer snapshot-access-new') {
        throw new Error('Snapshot catalog received a stale credential')
      }
      writeFileSync('renewal-proof.json', JSON.stringify({ requests, renewals: Number(renewed) }) + '\n')
      return Response.json({ code: 200, data: [{ name: 'weekly_reports' }] })
    }
    globalThis.fetch = fixtureFetch
    return () => {
      if (globalThis.fetch !== fixtureFetch) throw new Error('Snapshot fetch owner changed')
      globalThis.fetch = original
    }
  })
  ctx.on('internal/service', (name) => {
    if (name !== 'g1brain') return
    queueMicrotask(() => {
      const service = ctx.get('g1brain')
      if (!service) return
      ctx.effect(() => service.connectAuthentication(async (accessToken) => {
        if (!rejected || renewed || accessToken !== 'snapshot-access-old') throw new Error('Unexpected snapshot renewal')
        renewed = true
        return { kind: 'updated', credential: { accessToken: 'snapshot-access-new', userId: 'snapshot-user', revision: 2 } }
      }).dispose)
    })
  })
}
