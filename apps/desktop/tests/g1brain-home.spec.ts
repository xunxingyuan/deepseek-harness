import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { G1BRAIN_HOME_DIR_NAME, resolveDesktopPaths, resolveG1brainDesktopHome } from '../src/paths.ts'

describe('G1brain Desktop data home', () => {
  it('defaults outside the upstream Harness home and keeps the profile beneath it', () => {
    const home = resolveG1brainDesktopHome({}, join(homedir(), 'test-user'))
    expect(home).toBe(resolve(join(homedir(), 'test-user', G1BRAIN_HOME_DIR_NAME)))
    expect(home).not.toBe(resolve(join(homedir(), '.dsh')))
    expect(resolveDesktopPaths(home)).toEqual({ profile: join(home, 'profiles', 'desktop'),
      lock: join(home, 'profiles', 'desktop', 'lock') })
  })

  it('respects an explicit override and treats a blank value as unset', () => {
    const userHome = join(homedir(), 'test-user')
    expect(resolveG1brainDesktopHome({ DSH_HOME: '/private/tmp/g1brain-custom-home' }, userHome))
      .toBe(resolve('/private/tmp/g1brain-custom-home'))
    expect(resolveG1brainDesktopHome({ DSH_HOME: '   ' }, userHome))
      .toBe(resolve(join(userHome, G1BRAIN_HOME_DIR_NAME)))
  })
})
