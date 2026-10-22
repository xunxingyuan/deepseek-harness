/** Localized welcome copy and write-only credential actions. */

import { contextBridge, ipcRenderer } from 'electron'
import { resolveDesktopLocale } from './locale.ts'
import { WELCOME_IPC, type G1brainLoginInput, type G1brainLoginResult, type WelcomeApi,
  type G1brainConnections, type G1brainConnectionResult } from './welcome-api.ts'

const prefix = '--dsh-welcome-locale='
const locale = process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length)
if (locale === undefined) throw new Error('desktop welcome: missing window locale')
const api: WelcomeApi = {
  ...resolveDesktopLocale(locale),
  readConnections: () => ipcRenderer.invoke(WELCOME_IPC.connectionsRead) as Promise<G1brainConnections>,
  saveConnections: settings => ipcRenderer.invoke(WELCOME_IPC.connectionsSave, settings) as Promise<G1brainConnectionResult>,
  loginG1brain: (input: G1brainLoginInput) => ipcRenderer.invoke(WELCOME_IPC.g1brainLogin, input) as Promise<G1brainLoginResult>,
  g1brainMode: () => ipcRenderer.invoke(WELCOME_IPC.g1brainMode) as Promise<'local-dev' | 'oauth'>,
  analytics: async (eventName, attributes) => {
    if (await api.analyticsEnabled()) await ipcRenderer.invoke(WELCOME_IPC.analytics, eventName, attributes)
  },
  analyticsEnabled: () => ipcRenderer.invoke(WELCOME_IPC.analyticsEnabled) as Promise<boolean>,
}
contextBridge.exposeInMainWorld('dshWelcome', api)
