vi.mock('../src/web-document.ts', () => ({ authenticateWebHost: async () => 'test-cookie', serveWebDocument: vi.fn(), forwardWebRequest: vi.fn() }))
/** Welcome startup uses the Host before transitioning to the workspace. */

import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindowConstructorOptions } from 'electron'
import type { DesktopLocale } from '../src/locale.ts'
import type { AccountView } from '@deepseek-ai/dsh-deepseek-account/types'
import type { G1brainConnectionInput, WelcomeOperations } from '../src/welcome-api.ts'
import type { G1brainHostCredential, G1brainRefreshResult } from '../src/g1brain-auth.ts'
import { DESKTOP_IPC } from '../src/ipc.ts'

const state = vi.hoisted(() => ({
  appListeners: new Map<string, (...args: unknown[]) => void>(),
  dialogLocale: undefined as (() => DesktopLocale) | undefined,
  beforeRead: vi.fn(async () => {}),
  beforeWelcome: vi.fn(async () => {}),
  copy: vi.fn(),
  expiryListener: undefined as (() => void) | undefined,
  accountListener: undefined as ((value: AccountView) => void) | undefined,
  accountState: vi.fn<() => Promise<AccountView>>().mockResolvedValue({
    status: 'signed-out', attempt: null, links: { usageUrl: '', topUpUrl: '' },
  }),
  quit: vi.fn(),
  startHost: vi.fn().mockResolvedValue({ url: 'http://127.0.0.1:3080/?token=test', injections: [] }),
  stopHost: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  loadWorkspace: vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined),
  showWorkspace: vi.fn(),
  showInactiveWorkspace: vi.fn(),
  focusWorkspace: vi.fn(),
  moveTopWorkspace: vi.fn(),
  openDevTools: vi.fn(),
  closeWelcome: vi.fn(),
  destroyWorkspace: vi.fn(),
  confirm: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
  savedConnections: undefined as G1brainConnectionInput | undefined,
  hostEnvironments: [] as NodeJS.ProcessEnv[],
  g1brainExpiries: [] as Array<(() => void) | undefined>,
  g1brainRefreshes: [] as Array<((token?: string) => Promise<G1brainRefreshResult>) | undefined>,
  g1brainUpdates: [] as G1brainHostCredential[],
  welcomeLocale: undefined as DesktopLocale | undefined,
  preference: 'zh',
  hasApiKey: false,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
  contents: undefined as { mainFrame: { url: string } } | undefined,
  windowOptions: undefined as BrowserWindowConstructorOptions | undefined,
  menu: vi.fn(),
  operations: undefined as WelcomeOperations | undefined,
  nativeTheme: { themeSource: 'system', shouldUseDarkColors: false },
}))

vi.mock('../src/crash-report.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/crash-report.ts')>(),
  writeCrashReport: vi.fn(async () => undefined),
  pruneCrashReports: vi.fn(async () => {}),
}))
vi.mock('electron', () => ({
  clipboard: { writeText: state.copy },
  app: {
    isPackaged: false,
    name: 'Harness',
    requestSingleInstanceLock: () => true,
    setAsDefaultProtocolClient: vi.fn(),
    whenReady: () => Promise.resolve(),
    getLocale: () => 'en',
    getVersion: () => '1.0.0',
    setAboutPanelOptions: vi.fn(),
    getAppPath: () => '/development-app',
    getPath: (name: string) => name === 'userData' ? '/desktop-user-data' : `/development-${name}`,
    setAppLogsPath: vi.fn(),
    getPreferredSystemLanguages: () => ['en-US'],
    on: (name: string, callback: (...args: unknown[]) => void) => { state.appListeners.set(name, callback) },
    quit: state.quit,
    exit: vi.fn(),
  },
  powerMonitor: { on: vi.fn(), off: vi.fn() },
  BrowserWindow: class {
    constructor(options: BrowserWindowConstructorOptions) { state.windowOptions = options }
    private ready: (() => void) | undefined
    webContents = { mainFrame: { url: 'dsh-app://app/' }, setWindowOpenHandler: vi.fn(),
      on: vi.fn(), once: vi.fn(), send: vi.fn(), openDevTools: state.openDevTools }
    static getAllWindows() { return [] }
    once(name: string, callback: () => void) { if (name === 'ready-to-show') this.ready = callback; return this }
    on() { return this }
    private destroyed = false
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true; state.destroyWorkspace() }
    isMinimized() { return false }
    restore = vi.fn()
    focus = state.focusWorkspace
    moveTop = state.moveTopWorkspace
    hide = vi.fn()
    show = state.showWorkspace
    showInactive = state.showInactiveWorkspace
    async loadURL(url: string) { state.contents = this.webContents; await state.loadWorkspace(url); this.ready?.() }
  },
  net: { fetch: vi.fn() },
  nativeTheme: state.nativeTheme,
  session: { defaultSession: {
    setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(), webRequest: { onBeforeSendHeaders: vi.fn() },
  } },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  ipcMain: {
    handle: (name: string, callback: (...args: unknown[]) => unknown) => { state.handlers.set(name, callback) },
    on: (name: string, callback: (...args: unknown[]) => void) => { state.listeners.set(name, callback) },
  },
  dialog: { showErrorBox: vi.fn(), showMessageBox: vi.fn() },
  Menu: { buildFromTemplate: state.menu, setApplicationMenu: vi.fn() },
  nativeImage: { createFromPath: (path: string) => ({ path }) },
}))
// The Windows tray relabels through Menu as well; keep the menu call counts below platform-neutral.
vi.mock('../src/tray.ts', () => ({ DesktopTray: class { relabel() {} dispose() {} } }))

vi.mock('../src/paths.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/paths.ts')>(), resolveDesktopPaths: () => ({ profile: '/profile' }),
}))
vi.mock('../src/g1brain-connections.ts', () => ({ DEFAULT_G1BRAIN_CLIENT_ID: 'lhzstp', G1brainConnectionStore: class {
  async load() { return state.savedConnections }
  async save(settings: G1brainConnectionInput) { state.savedConnections = settings }
} }))
vi.mock('../src/login-shell-environment.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/login-shell-environment.ts')>(),
  readDesktopLoginShellEnvironment: async (base: NodeJS.ProcessEnv) => ({ environment: base, failures: [] }),
}))
vi.mock('../src/project-manager.ts', () => ({ DesktopProjectManager: class {
  applyRelease = vi.fn(async () => {})
  canRecoverProfile = vi.fn(() => true)
} }))
vi.mock('../src/host-process.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/host-process.ts')>(),
  DesktopHostProcess: class {
    constructor(_node: string, _runtime: string, _project: string, _port: unknown, environment: NodeJS.ProcessEnv,
      _failure?: unknown, _primary?: unknown, _manager?: unknown, _platform?: unknown, g1brainExpired?: () => void,
      refresh?: (token?: string) => Promise<G1brainRefreshResult>) {
      state.hostEnvironments.push(environment)
      state.g1brainExpiries.push(g1brainExpired)
      state.g1brainRefreshes.push(refresh)
    }
    start = state.startHost
    stop = state.stopHost
    updateG1brainAuthentication(credential: G1brainHostCredential) { state.g1brainUpdates.push(credential) }
    fetch() {
      return Promise.resolve(Response.json({
        loggedIn: false, hasApiKey: state.hasApiKey, writable: true, localePreference: state.preference,
      }))
    }
  },
}))
vi.mock('../src/welcome-backend.ts', () => ({
  connectDesktopWelcome: async () => ({
    analyticsEnabled: async () => false,
    readLocalePreference: async () => state.preference,
    read: async () => {
      await state.beforeRead()
      return { loggedIn: false, hasApiKey: state.hasApiKey, writable: true, localePreference: state.preference }
    },
    save: async () => ({ ok: true }),
    account: {
      watch: (listener: (value: AccountView) => void, _failed: () => void, expired: () => void) => {
        state.accountListener = listener
        state.expiryListener = expired
        return () => {}
      },
      state: state.accountState,
    },
  }),
}))
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  readFile: vi.fn(async () => '{}'),
}))
vi.mock('../src/update-dialog.ts', () => ({ DesktopUpdateDialog: class {
  constructor(_preload: string, locale: () => DesktopLocale) { state.dialogLocale = locale }
  dispose() {}
  show = state.confirm
} }))
vi.mock('../src/update-coordinator.ts', () => ({ DesktopUpdateCoordinator: class {
  state = { phase: 'idle' }
  check = vi.fn(async () => this.state)
  dispose = vi.fn()
} }))
vi.mock('../src/welcome-window.ts', () => ({
  openWelcomeWindow: async (locale: DesktopLocale, operations: WelcomeOperations) => {
    state.welcomeLocale = locale
    state.operations = operations
    await state.beforeWelcome()
    return { once: vi.fn(), close: state.closeWelcome, isDestroyed: () => false,
      show: vi.fn(), focus: vi.fn(), webContents: { send: vi.fn() } }
  },
}))

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it.each(['deadline', 'server-401', 'saved-credentials', 'renewal'])('isolates the G1brain credential lifecycle (%s)', async (reason) => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  state.operations = undefined
  state.savedConnections = undefined
  state.hostEnvironments.length = 0
  state.g1brainExpiries.length = 0
  state.g1brainRefreshes.length = 0
  state.g1brainUpdates.length = 0
  state.beforeRead.mockResolvedValue(undefined)
  state.beforeWelcome.mockResolvedValue(undefined)
  vi.stubEnv('DSH_CLIENT_VERSION', '1.2.3')
  vi.stubEnv('DSH_DESKTOP_DEV_PROJECT_DIR', '/development-profile')
  vi.stubEnv('DSH_DESKTOP_NODE_BINARY', '/runtime/node')
  vi.stubEnv('DSH_DESKTOP_PNPM_ENTRY', '/runtime/pnpm')
  vi.stubEnv('DSH_DESKTOP_DSH_DIR', '/runtime/dsh')
  vi.stubEnv('DSH_DESKTOP_PRIMARY_RUNTIME_DIR', '/runtime/primary-runtime')
  vi.stubEnv('DSH_DESKTOP_OPEN_DEVTOOLS', '0')
  vi.stubEnv('DSH_DESKTOP_MANDATORY_UPDATE_CONFIG', undefined)
  vi.stubEnv('G1BRAIN_AUTH_MODE', 'oauth')
  vi.stubEnv('G1BRAIN_CLIENT_SECRET', 'fixture-secret')
  if (reason === 'saved-credentials') {
    vi.stubEnv('G1BRAIN_AUTH_MODE', undefined)
    vi.stubEnv('G1BRAIN_CLIENT_SECRET', undefined)
    state.savedConnections = { baseUrl: 'http://configured.test:19091', tableBaseUrl: '',
      clientId: 'configured-client', clientSecret: 'saved-private-secret' }
  }
  const { net } = await import('electron')
  const send = vi.spyOn(net, 'fetch').mockResolvedValue(Response.json({ access_token: 'private-fixture-token', user_id: 'user-1', expires_in: 32 }))
  if (reason === 'renewal') send.mockReset()
    .mockResolvedValueOnce(Response.json({ access_token: 'private-fixture-token', refresh_token: 'private-refresh-token', user_id: 'user-1', expires_in: 100 }))
    .mockResolvedValueOnce(Response.json({ access_token: 'renewed-access-token', refresh_token: 'rotated-refresh-token', expires_in: 100 }))
  await import('../src/main.ts')
  await vi.waitFor(() => { expect(state.operations).toBeDefined() })
  if (reason === 'saved-credentials') {
    expect(await state.operations!.g1brainMode()).toBe('oauth')
    expect(await state.operations!.readConnections()).toEqual({ baseUrl: 'http://configured.test:19091', tableBaseUrl: '',
      clientId: 'configured-client', clientSecretConfigured: true })
  }
  const result = await state.operations!.loginG1brain({ username: 'alice', password: 'fixture-password' })
  expect(result).toEqual({ ok: true, username: 'alice' })
  expect(JSON.stringify(result)).not.toContain('private-fixture-token')
  expect(state.startHost).toHaveBeenCalledTimes(2)
  expect(state.hostEnvironments[1]).toMatchObject({ G1BRAIN_ACCESS_TOKEN: 'private-fixture-token', G1BRAIN_USER_ID: 'user-1' })
  state.g1brainExpiries[0]?.()
  await vi.advanceTimersByTimeAsync(0)
  expect(state.startHost).toHaveBeenCalledTimes(2)
  const shownBefore = state.beforeWelcome.mock.calls.length
  if (reason === 'renewal') {
    await vi.advanceTimersByTimeAsync(80001)
    expect(state.startHost).toHaveBeenCalledTimes(2)
    expect(state.g1brainUpdates.at(-1)).toMatchObject({ accessToken: 'renewed-access-token', revision: 2 })
    expect(state.beforeWelcome).toHaveBeenCalledTimes(shownBefore)
    expect(JSON.stringify(state.hostEnvironments)).not.toContain('private-refresh-token')
    expect(JSON.stringify(state.g1brainUpdates)).not.toContain('rotated-refresh-token')
    expect(await state.g1brainRefreshes[1]?.('private-fixture-token')).toMatchObject({ kind: 'updated', credential: { accessToken: 'renewed-access-token' } })
    expect(send).toHaveBeenCalledTimes(2)
    return
  }
  if (reason !== 'deadline') state.g1brainExpiries[1]?.()
  else await vi.advanceTimersByTimeAsync(32001)
  await vi.waitFor(() => { expect(state.startHost).toHaveBeenCalledTimes(3) })
  expect(state.beforeWelcome).toHaveBeenCalledTimes(shownBefore + 1)
  expect(state.hostEnvironments[2]?.G1BRAIN_ACCESS_TOKEN).toBeUndefined()
  expect(state.hostEnvironments[2]?.G1BRAIN_USER_ID).toBeUndefined()
  expect(state.confirm).not.toHaveBeenCalled()
})

it.each([false, true])('opens the G1brain welcome and enters after local login (Windows update=%s)', async (updated) => {
  vi.resetModules()
  vi.clearAllMocks()
  state.preference = 'zh'
  state.hasApiKey = false
  state.operations = undefined
  state.savedConnections = undefined
  state.hostEnvironments.length = 0
  state.confirm.mockResolvedValue({ response: 0, checkboxChecked: false })
  state.accountState.mockResolvedValue({ status: 'signed-out', attempt: null, links: { usageUrl: '', topUpUrl: '' } })
  if (updated) vi.stubGlobal('process', { ...process, platform: 'win32', argv: ['desktop', '--updated'] })
  vi.useFakeTimers()
  vi.stubEnv('DSH_CLIENT_VERSION', '1.2.3')
  vi.stubEnv('DSH_DESKTOP_DEV_PROJECT_DIR', '/development-profile')
  vi.stubEnv('DSH_DESKTOP_NODE_BINARY', '/runtime/node')
  vi.stubEnv('DSH_DESKTOP_PNPM_ENTRY', '/runtime/pnpm')
  vi.stubEnv('DSH_DESKTOP_DSH_DIR', '/runtime/dsh')
  vi.stubEnv('DSH_DESKTOP_PRIMARY_RUNTIME_DIR', '/runtime/primary-runtime')
  vi.stubEnv('DSH_DESKTOP_HOST_INSPECT_PORT', undefined)
  vi.stubEnv('DSH_DESKTOP_OPEN_DEVTOOLS', '0')
  vi.stubEnv('DSH_DESKTOP_MANDATORY_UPDATE_CONFIG', undefined)
  vi.stubEnv('DSH_DESKTOP_UPDATE_JOURNAL_DIR', undefined)
  const reading = Promise.withResolvers<undefined>()
  const loading = Promise.withResolvers<undefined>()
  state.beforeRead.mockReturnValueOnce(reading.promise)
  state.beforeWelcome.mockReturnValueOnce(loading.promise)
  const activate = () => {
    state.appListeners.get('second-instance')!()
    state.appListeners.get('open-url')!({ preventDefault: vi.fn() }, 'g1brainxdeepseek://open')
  }
  await import('../src/main.ts')
  await vi.waitFor(() => { expect(state.beforeRead).toHaveBeenCalledOnce() })
  try {
    activate()
    expect(state.showWorkspace).not.toHaveBeenCalled()
    reading.resolve(undefined)
    await vi.waitFor(() => { expect(state.beforeWelcome).toHaveBeenCalledOnce() })
    activate()
    expect(state.showWorkspace).not.toHaveBeenCalled()
  } finally {
    reading.resolve(undefined)
    loading.resolve(undefined)
  }
  await vi.waitFor(() => { expect(state.operations).toBeDefined() })
  expect(state.startHost).toHaveBeenCalledOnce()
  expect(state.loadWorkspace).toHaveBeenCalledExactlyOnceWith('dsh-app://app/')
  expect(state.showWorkspace).not.toHaveBeenCalled()
  state.loadWorkspace.mockClear()
  expect(state.welcomeLocale).toMatchObject({ id: 'zh-CN' })
  expect(state.dialogLocale!().id).toBe('zh-CN')
  const account: AccountView = { status: 'signed-out', links: { usageUrl: '', topUpUrl: '' },
    attempt: null }
  state.accountState.mockResolvedValue(account)
  expect(await state.operations!.g1brainMode()).toBe('local-dev')
  expect(await state.operations!.loginG1brain({ username: ' admin ', password: 'development-password' }))
    .toEqual({ ok: true, username: 'admin' })
  expect(state.copy).not.toHaveBeenCalled()
  expect(state.loadWorkspace).not.toHaveBeenCalled()
  expect(state.showWorkspace).toHaveBeenCalledOnce()
  expect(state.moveTopWorkspace).not.toHaveBeenCalled()
  expect(state.focusWorkspace).not.toHaveBeenCalled()
  expect(state.windowOptions).toMatchObject({
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 }, vibrancy: 'sidebar' } : {}),
    webPreferences: { contextIsolation: true, sandbox: true },
  })
  expect(state.closeWelcome).toHaveBeenCalledOnce()
  activate()
  expect(state.showWorkspace).toHaveBeenCalledTimes(3)
  expect(state.quit).not.toHaveBeenCalled()
  expect(state.stopHost).not.toHaveBeenCalled()
  const contents = state.contents as { mainFrame: { url: string }; send: ReturnType<typeof vi.fn> }
  expect(contents.send).toHaveBeenCalledWith(DESKTOP_IPC.enterWorkspace)
  const event = { sender: contents, senderFrame: contents.mainFrame }
  const bootstrap = state.handlers.get(DESKTOP_IPC.localeBootstrap)!
  expect(await bootstrap(event)).toEqual({ languages: ['en-US'], preference: 'zh' })
  state.preference = 'en'
  expect(await bootstrap(event)).toEqual({ languages: ['en-US'], preference: 'en' })
  const changed = state.listeners.get(DESKTOP_IPC.localeChanged)!
  const initialMenus = state.menu.mock.calls.length
  changed({ ...event, senderFrame: {} }, 'en')
  changed(event, 42)
  expect(state.menu).toHaveBeenCalledTimes(initialMenus)
  changed(event, 'en')
  expect(state.dialogLocale!().id).toBe('en')
  expect(state.menu).toHaveBeenCalledTimes(initialMenus + 1)
  expect(await bootstrap(event)).toEqual({ languages: ['en-US'], preference: 'en' })
  const welcomeCount = state.beforeWelcome.mock.calls.length
  state.hasApiKey = true
  state.accountListener!({ ...account, status: 'credential-stored', attempt: null })
  state.accountListener!({ ...account, status: 'signed-out', attempt: null })
  state.expiryListener!()
  await vi.advanceTimersByTimeAsync(0)
  expect(state.beforeWelcome).toHaveBeenCalledTimes(welcomeCount)
  expect(state.openDevTools).not.toHaveBeenCalled()

  expect(await state.operations!.saveConnections({ baseUrl: 'http://new-server.test:19091', tableBaseUrl: '', clientId: 'lhzstp', clientSecret: '' }))
    .toEqual({ ok: false, reason: 'busy' })
  const signOut = state.handlers.get(DESKTOP_IPC.g1brainSignOut)!
  expect(() => signOut({ ...event, senderFrame: { url: 'dsh-app://app/' } })).toThrow('unowned renderer')
  state.confirm.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
  expect(await signOut(event)).toBe(false)
  expect(state.stopHost).not.toHaveBeenCalled()
  expect(await signOut(event)).toBe(true)
  expect(state.beforeWelcome).toHaveBeenCalledTimes(welcomeCount + 1)
  expect(state.destroyWorkspace).toHaveBeenCalledOnce()
  expect(state.stopHost).toHaveBeenCalledOnce()
  expect(state.startHost).toHaveBeenCalledTimes(2)
  expect(() => signOut(event)).toThrow('unowned renderer')
  const settings = { baseUrl: 'http://new-server.test:19091', tableBaseUrl: '', clientId: 'lhzstp', clientSecret: '' }
  const publicSettings = { baseUrl: settings.baseUrl, tableBaseUrl: '', clientId: 'lhzstp', clientSecretConfigured: false }
  expect(await state.operations!.saveConnections(settings)).toEqual({ ok: true, settings: publicSettings })
  expect(state.savedConnections).toEqual(settings)
  expect(state.hostEnvironments.at(-1)).toMatchObject({ G1BRAIN_BASE_URL: settings.baseUrl, G1BRAIN_TABLE_BASE_URL: '' })
  expect(state.startHost).toHaveBeenCalledTimes(3)
  expect(await state.operations!.readConnections()).toEqual(publicSettings)
  expect(await state.operations!.loginG1brain({ username: 'second-user', password: 'development-password' }))
    .toEqual({ ok: true, username: 'second-user' })
  expect(state.closeWelcome).toHaveBeenCalledTimes(2)
  expect(state.loadWorkspace).toHaveBeenCalledExactlyOnceWith('dsh-app://app/')

})
