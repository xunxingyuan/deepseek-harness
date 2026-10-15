// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Welcome } from '../src/client/WelcomePage.tsx'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { G1brainLoginInput, G1brainLoginResult, WelcomeApi } from '../src/welcome-api.ts'

afterEach(cleanup)

function mount(language = 'zh-CN') {
  const loginG1brain = vi.fn<(input: G1brainLoginInput) => Promise<G1brainLoginResult>>()
    .mockResolvedValue({ ok: true, username: 'admin' })
  const api: WelcomeApi = {
    ...resolveDesktopLocale(language), loginG1brain, g1brainMode: async () => 'local-dev',
    analyticsEnabled: async () => false,
  }
  render(<Welcome api={api} />)
  const username = screen.getByLabelText(api.messages.g1brainUsername) as HTMLInputElement
  const password = screen.getByLabelText(api.messages.g1brainPassword) as HTMLInputElement
  const button = document.getElementById('g1brain-login-submit') as HTMLButtonElement
  const submit = () => fireEvent.submit(document.getElementById('g1brain-login-form')!)
  return { api, loginG1brain, username, password, button, submit }
}

describe('G1brain welcome form', () => {
  it.each(['zh-CN', 'en'])('shows only G1brain sign-in in %s', async (language) => {
    const view = mount(language)
    await vi.waitFor(() => { expect(document.getElementById('g1brain-dev-mode')).not.toBeNull() })
    expect(document.title).toBe('G1brain × DeepSeek')
    expect(view.password.type).toBe('password')
    expect(document.getElementById('sign-in')).toBeNull()
    expect(document.getElementById('api-key')).toBeNull()
    const copy = [document.title, document.getElementById('g1brain-login-title')!.textContent,
      view.api.messages.g1brainLoginDescription, view.username.labels?.[0]?.textContent,
      view.password.labels?.[0]?.textContent, view.button.textContent,
      document.getElementById('g1brain-dev-mode')!.textContent, ''].join('\n')
    await expect(copy).toMatchFileSnapshot(`./expected/welcome/${language}.expected.txt`)
  })

  it('requires both fields and sends one trimmed account without keeping the password', async () => {
    const view = mount()
    view.submit()
    expect(view.loginG1brain).not.toHaveBeenCalled()
    expect(document.getElementById('g1brain-login-error')!.textContent).toBe(view.api.messages.g1brainLoginRequired)
    fireEvent.change(view.username, { target: { value: ' admin ' } })
    fireEvent.change(view.password, { target: { value: 'test-password' } })
    view.submit()
    await vi.waitFor(() => { expect(view.loginG1brain).toHaveBeenCalledExactlyOnceWith({ username: 'admin', password: 'test-password' }) })
    await vi.waitFor(() => { expect(view.password.value).toBe('') })
  })

  it('blocks duplicate requests and displays a safe failure', async () => {
    const view = mount()
    const pending = Promise.withResolvers<G1brainLoginResult>()
    view.loginG1brain.mockReturnValueOnce(pending.promise)
    fireEvent.change(view.username, { target: { value: 'admin' } })
    fireEvent.change(view.password, { target: { value: 'wrong' } })
    view.submit()
    expect(view.button.disabled).toBe(true)
    view.submit()
    expect(view.loginG1brain).toHaveBeenCalledTimes(1)
    await act(async () => { pending.resolve({ ok: false, reason: 'invalid-credentials' }) })
    expect(document.getElementById('g1brain-login-error')!.textContent).toBe(view.api.messages.g1brainLoginInvalid)
    expect(view.password.value).toBe('')
    expect(view.button.disabled).toBe(false)
  })
})
