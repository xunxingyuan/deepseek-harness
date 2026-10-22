// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import { G1brainSignOut, type G1brainSignOutInjected } from '../src/client/G1brainSignOut.tsx'

afterEach(() => { vi.unstubAllGlobals() })

it.each([true, false])('registers a disposable sign-out footer only for native Desktop (%s)', async (desktop) => {
  const nativeSignOut = vi.fn(async () => false)
  vi.stubGlobal('dshDesktop', desktop ? { g1brain: { signOut: nativeSignOut } } : undefined)
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('layout', { selectPanel: vi.fn() } as never)
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: {
    main: { kind: 'keyed', scope: 'root' },
    'sidebar.footer.action': { kind: 'list', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
    'sidebar.brand.mark': { kind: 'single', scope: 'root' },
    'sidebar.brand.name': { kind: 'single', scope: 'root' },
  } } as never, () => null)
  const fiber = ctx.plugin(Object.assign((owned: Context) => { apply(owned) }, { inject: ['slots', 'locale', 'layout'] }))
  await fiber.await()
  const entries = slots.entries('sidebar.footer.action')
  expect(entries).toHaveLength(desktop ? 1 : 0)
  if (desktop) {
    expect(entries[0]?.component).toBe(G1brainSignOut)
    const injected = entries[0]?.inject?.()
    const signOut = injected?.signOut as G1brainSignOutInjected['signOut']
    expect(await signOut()).toBe(false)
    expect(nativeSignOut).toHaveBeenCalledOnce()
  }
  await fiber.dispose()
  expect(slots.entries('sidebar.footer.action')).toHaveLength(0)
})
