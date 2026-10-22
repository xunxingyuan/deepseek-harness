// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { G1brainSignOut } from '../src/client/G1brainSignOut.tsx'
import { zh, type G1brainKey } from '../src/client/locales.ts'

afterEach(cleanup)
const t = ((key: G1brainKey) => zh[key]) as PropsLocale<'g1brain'>['t']
const unusedHook = (): never => { throw new Error('The sign-out footer does not read standard data hooks') }
const standard = { usePanelInfo: unusedHook, useSessions: unusedHook, useSessionStatus: unusedHook,
  useSessionRetainInfo: unusedHook, useWorkspaces: unusedHook, useResource: unusedHook }

it('shows the native sign-out action and prevents duplicate requests', async () => {
  const pending = Promise.withResolvers<boolean>()
  const signOut = vi.fn(() => pending.promise)
  render(<G1brainSignOut {...standard} wide={true} t={t} signOut={signOut} />)
  fireEvent.click(screen.getByRole('button', { name: zh.signOut }))
  fireEvent.click(screen.getByRole('button', { name: zh.signOut }))
  expect(signOut).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true)
  pending.resolve(false)
  await waitFor(() => { expect(screen.getByRole('button').hasAttribute('disabled')).toBe(false) })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('keeps an accessible compact control and displays only a safe native failure', async () => {
  render(<G1brainSignOut {...standard} wide={false} t={t} signOut={async () => { throw new Error('private diagnostic') }} />)
  const button = screen.getByRole('button', { name: zh.signOut })
  expect(button.textContent).toBe('')
  fireEvent.click(button)
  expect((await screen.findByRole('alert')).textContent).toBe(zh.signOutFailed)
  expect(document.body.textContent).not.toContain('private diagnostic')
})
