/** Filesystem ownership for the Electron-managed desktop installation. */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Default G1brain data directory under the user's home, outside the upstream `~/.dsh`. */
export const G1BRAIN_HOME_DIR_NAME = '.g1brainxdeepseek'

/** Resolve the G1brain home, respecting an explicit `DSH_HOME` override.
 * @param environment - Desktop launch environment.
 * @param userHome - User's home directory; injectable for deterministic tests.
 * @returns an absolute home distinct from upstream by default.
 */
export function resolveG1brainDesktopHome(environment: NodeJS.ProcessEnv = process.env, userHome = homedir()): string {
  return environment.DSH_HOME?.trim() ? resolveDshHome(undefined, environment)
    : resolveDshHome(join(userHome, G1BRAIN_HOME_DIR_NAME), environment)
}

/** Stable desktop installation paths under the selected G1brain home. */
export interface DesktopPaths {
  readonly profile: string
  readonly lock: string
}

/**
 * Resolve every Electron-owned path under the selected Desktop data root.
 * @param dshHome - G1brain Desktop home; the launcher resolves the default first.
 * @returns immutable desktop path set.
 */
export function resolveDesktopPaths(dshHome: string = resolveG1brainDesktopHome()): DesktopPaths {
  return {
    profile: join(dshHome, 'profiles', 'desktop'),
    lock: join(dshHome, 'profiles', 'desktop', 'lock'),
  }
}
