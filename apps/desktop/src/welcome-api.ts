/** Operations available to the isolated native welcome renderer. */

import type { ProductEventMap } from '@deepseek-ai/dsh-client-product-analytics/types'
import type { DesktopLocale } from './locale.ts'

/** Private native welcome channels, installed only while its window exists. */
export const WELCOME_IPC = {
  g1brainLogin: 'g1brain-welcome:login',
  g1brainMode: 'g1brain-welcome:mode',
  analytics: 'dsh-welcome:analytics',
  analyticsEnabled: 'dsh-welcome:analytics-enabled',
} as const

/** G1brain credentials are write-only at the Welcome IPC boundary. */
export interface G1brainLoginInput { readonly username: string; readonly password: string }
export type G1brainLoginResult =
  | { readonly ok: true; readonly username: string }
  | { readonly ok: false; readonly reason: 'missing-config' | 'invalid-credentials' | 'unavailable' }

type WelcomeEventName = 'auth_page_view' | 'auth_page_click' | 'api_key_save_click'

/** Host-owned operations used by the welcome window. */
export interface WelcomeOperations {
  /** @param input - username and password delivered only to the Electron main process. @returns safe login status. */
  loginG1brain(input: G1brainLoginInput): Promise<G1brainLoginResult>
  /** @returns whether the login will validate against OAuth or use the local development session. */
  g1brainMode(): Promise<'local-dev' | 'oauth'>
  /** @param eventName - allowed welcome event. @param attributes - approved fields without credentials. */
  analytics?<K extends WelcomeEventName>(eventName: K, attributes: ProductEventMap[K]): Promise<void>
  /** @returns the Host's current effective collection policy. */
  analyticsEnabled(): Promise<boolean>
}

/** The renderer receives localized copy and G1brain login operations. */
export type WelcomeApi = DesktopLocale & WelcomeOperations

/** G1brain login and separately configured model-key facts supplied at cold start. */
export interface WelcomeAuthentication {
  readonly loggedIn: boolean
  readonly hasApiKey: boolean
}

/**
 * Decide whether a startup or sign-out requires the welcome entry.
 * @param authentication - current account and independently stored API-key facts.
 * @returns true until the G1brain session is established, regardless of model-key configuration.
 */
export function needsWelcome(authentication: WelcomeAuthentication): boolean {
  return !authentication.loggedIn
}
