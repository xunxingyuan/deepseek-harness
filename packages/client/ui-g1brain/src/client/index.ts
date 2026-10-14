/** G1brain entry panel for the desktop profile. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { G1brainHome, type G1brainHomeInjected } from './G1brainHome.tsx'
import { G1brainBrandMark, G1brainBrandName } from './G1brainBrand.tsx'
import { G1brainIcon } from './G1brainIcon.tsx'
import { en, zh, type G1brainKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** G1brain desktop workbench copy. */
    g1brain: G1brainKey
  }
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    g1brainPreparation: unknown
  }
}

const PANEL_ID = 'g1brain' as MainPanelId

/** Required browser services. */
export const inject = ['slots', 'locale', 'layout', 'remote', 'remote.g1brain', 'workspaces', 'uiWorkspace', 'sessions', 'conversation']

/** Mount the G1brain landing panel and select it on desktop startup. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('g1brain', { zh, en }), 'g1brain: dictionaries')
  const t = ctx.locale.bind('g1brain')
  const desktopPicker = (globalThis as typeof globalThis & {
    __DSH_DIRECTORY_PICKER__?: { pick(): Promise<string | null> }
  }).__DSH_DIRECTORY_PICKER__
  const loadCatalog: G1brainHomeInjected['loadCatalog'] = async () => {
    const status = await ctx.remote.g1brain.status()
    if (!status.ok) throw new Error(status.error.message)
    if (!status.value.configured) return { configured: false, mode: status.value.mode, ontologies: [], libraries: [] }
    try {
      const [ontologies, libraries] = await Promise.all([
        ctx.remote.g1brain.listOntologyCollections(),
        ctx.remote.g1brain.listDocumentLibraries(),
      ])
      if (!ontologies.ok) throw new Error(ontologies.error.message)
      if (!libraries.ok) throw new Error(libraries.error.message)
      return { configured: true, mode: status.value.mode, ontologies: ontologies.value, libraries: libraries.value }
    } catch (_error) {
      return { configured: true, mode: status.value.mode, ontologies: [], libraries: [], error: true }
    }
  }
  const loadDomains: G1brainHomeInjected['loadDomains'] = async (collectionName) => {
    const result = await ctx.remote.g1brain.listOntologyDomains(collectionName)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  ctx.slots.inject('main', () => {
    const dispose = ctx.slots.register({
      name: 'main', key: PANEL_ID, locale: 'g1brain',
      inject: (): G1brainHomeInjected => ({
        loadCatalog,
        loadDomains,
        pickDirectory: () => desktopPicker?.pick() ?? ctx.uiWorkspace.pickDirectory(),
        openSession: async ({ target, prompt }) => {
          const workspace = await ctx.workspaces.create({ path: target.folderPath })
          const sessionId = await ctx.sessions.create({ workspaceId: workspace.workspaceId })
          const result = await ctx.remote.g1brain.bindSession({ sessionId, target })
          if (!result.ok) throw new Error(result.error.message)
          const reference = ctx.sessions.retain(sessionId, { source: 'g1brainPreparation' })
          try {
            if (ctx.conversation.input.requestDraftInitialization(reference.binding, { prompt }) !== 'applied') {
              throw new Error('G1brain Session draft could not be prepared')
            }
            ctx.uiWorkspace.openSession(sessionId)
          } finally {
            reference.release()
          }
        },
      }),
    }, G1brainHome)
    queueMicrotask(() => {
      if (ctx.slots.entries('main').some(entry => entry.options.key === PANEL_ID)) ctx.layout.selectPanel(PANEL_ID)
    })
    return dispose
  })
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: -10, locale: 'g1brain', label: () => t('panel'),
  }, G1brainIcon))
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark' }, G1brainBrandMark))
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name', locale: 'g1brain' }, G1brainBrandName))
}
