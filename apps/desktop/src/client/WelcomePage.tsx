/** G1brain credential entry rendered in the isolated Desktop welcome window. */

import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { WelcomeApi } from '../welcome-api.ts'

/**
 * Collect G1brain credentials without exposing the OAuth client secret or token to this renderer.
 * @param props.api - the sender-checked main-process login channel.
 * @returns the username and password form.
 */
export function Welcome({ api }: { api: WelcomeApi }) {
  const { messages: m } = api
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [localMode, setLocalMode] = useState(false)
  const busyRef = useRef(false)
  const mounted = useRef(true)
  const usernameInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    mounted.current = true
    document.documentElement.lang = api.id
    document.title = m.welcomeTitle
    usernameInput.current?.focus()
    void api.g1brainMode().then((mode) => { if (mounted.current) setLocalMode(mode === 'local-dev') }).catch((_closedChannel: unknown) => {
      if (mounted.current) setLocalMode(false)
    })
    return () => { mounted.current = false }
  }, [api.id, m.welcomeTitle])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busyRef.current) return
    if (!username.trim() || !password) { setError(m.g1brainLoginRequired); return }
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const result = await api.loginG1brain({ username: username.trim(), password })
      if (!mounted.current) return
      if (!result.ok) {
        setError(result.reason === 'missing-config' ? m.g1brainLoginUnconfigured
          : result.reason === 'invalid-credentials' ? m.g1brainLoginInvalid : m.g1brainLoginUnavailable)
      }
    } catch {
      if (mounted.current) setError(m.g1brainLoginUnavailable)
    } finally {
      busyRef.current = false
      if (mounted.current) { setBusy(false); setPassword('') }
    }
  }

  return <>
    <div className="titlebar" aria-hidden="true" />
    <main className="welcome" aria-labelledby="g1brain-login-title">
      <img className="brand" src="assets/welcome-brand.svg" alt="" aria-hidden="true" width="472" height="40" />
      <form id="g1brain-login-form" className="key-form g1brain-form" noValidate onSubmit={(event) => { void submit(event) }} aria-busy={busy}>
        <header className="key-heading">
          <h1 id="g1brain-login-title">{m.g1brainLoginTitle}</h1>
          <p>{m.g1brainLoginDescription}</p>
          {localMode && <p id="g1brain-dev-mode">{m.g1brainLoginDevMode}</p>}
        </header>
        <div className="g1brain-fields">
          <label className="key-field" htmlFor="g1brain-username">
            <span>{m.g1brainUsername}</span>
            <input ref={usernameInput} id="g1brain-username" type="text" autoComplete="username" required
              value={username} disabled={busy} onChange={(event) => { setUsername(event.target.value); setError('') }} />
          </label>
          <label className="key-field" htmlFor="g1brain-password">
            <span>{m.g1brainPassword}</span>
            <input id="g1brain-password" type="password" autoComplete="current-password" required
              value={password} disabled={busy} onChange={(event) => { setPassword(event.target.value); setError('') }} />
          </label>
          <p id="g1brain-login-error" className="g1brain-error" role="alert" hidden={error === ''}>{error}</p>
        </div>
      </form>
      <div className="actions">
        <button id="g1brain-login-submit" className="primary" type="submit" form="g1brain-login-form" disabled={busy}>
          {busy ? m.g1brainLoggingIn : m.g1brainLoginSubmit}
        </button>
      </div>
    </main>
  </>
}
