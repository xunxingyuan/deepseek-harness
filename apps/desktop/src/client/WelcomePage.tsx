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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [tableBaseUrl, setTableBaseUrl] = useState('')
  const [notice, setNotice] = useState('')
  const busyRef = useRef(false)
  const mounted = useRef(true)
  const usernameInput = useRef<HTMLInputElement>(null)
  const addressInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (settingsOpen) addressInput.current?.focus()
    else usernameInput.current?.focus()
  }, [settingsOpen])

  async function openSettings() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    setNotice('')
    setPassword('')
    try {
      const settings = await api.readConnections()
      if (!mounted.current) return
      setBaseUrl(settings.baseUrl)
      setTableBaseUrl(settings.tableBaseUrl)
      setSettingsOpen(true)
    } catch (_failedRead: unknown) {
      if (mounted.current) setError(m.g1brainConnectionFailed)
    } finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault()
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const result = await api.saveConnections({ baseUrl: baseUrl.trim(), tableBaseUrl: tableBaseUrl.trim() })
      if (!mounted.current) return
      if (result.ok) {
        setSettingsOpen(false)
        setNotice(m.g1brainConnectionSaved)
      } else setError(result.reason === 'invalid-address' ? m.g1brainConnectionInvalid
        : result.reason === 'busy' ? m.g1brainConnectionBusy : m.g1brainConnectionFailed)
    } catch (_failedSave: unknown) {
      if (mounted.current) setError(m.g1brainConnectionFailed)
    } finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }

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
    <main className="welcome" aria-labelledby={settingsOpen ? 'g1brain-connections-title' : 'g1brain-login-title'}>
      <img className="brand" src="assets/welcome-brand.svg" alt="" aria-hidden="true" width="472" height="40" />
      {settingsOpen ? <form id="g1brain-connections-form" className="key-form connection-form" noValidate
        onSubmit={(event) => { void saveSettings(event) }} aria-busy={busy}>
        <header className="key-heading">
          <h1 id="g1brain-connections-title">{m.g1brainConnectionSettings}</h1>
          <p>{m.g1brainConnectionDescription}</p>
        </header>
        <div className="g1brain-fields">
          <label className="key-field" htmlFor="g1brain-service-address"><span>{m.g1brainServiceAddress}</span>
            <input ref={addressInput} id="g1brain-service-address" type="url" autoComplete="off" spellCheck={false}
              required disabled={busy} value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); setError('') }}
              aria-describedby="g1brain-address-hint" />
          </label>
          <label className="key-field" htmlFor="g1brain-table-address"><span>{m.g1brainTableAddress}</span>
            <input id="g1brain-table-address" type="url" autoComplete="off" spellCheck={false} disabled={busy}
              value={tableBaseUrl} onChange={(event) => { setTableBaseUrl(event.target.value); setError('') }}
              aria-describedby="g1brain-address-hint" />
          </label>
          <p id="g1brain-address-hint" className="connection-hint">{m.g1brainAddressHint}</p>
          {error && <p className="g1brain-error" role="alert">{error}</p>}
        </div>
      </form> : <form id="g1brain-login-form" className="key-form g1brain-form" noValidate onSubmit={(event) => { void submit(event) }} aria-busy={busy}>
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
          {notice && <p className="connection-hint" role="status">{notice}</p>}
        </div>
      </form>}
      <div className="actions">
        {settingsOpen ? <>
          <button className="primary" type="submit" form="g1brain-connections-form" disabled={busy}>
            {busy ? m.g1brainConnectionSaving : m.g1brainConnectionSave}
          </button>
          <button className="secondary" type="button" disabled={busy} onClick={() => { setSettingsOpen(false); setError('') }}>{m.cancel}</button>
        </> : <>
          <button id="g1brain-login-submit" className="primary" type="submit" form="g1brain-login-form" disabled={busy}>
            {busy ? m.g1brainLoggingIn : m.g1brainLoginSubmit}
          </button>
          <button className="connection-settings" type="button" disabled={busy} onClick={() => { void openSettings() }}>{m.g1brainConnectionSettings}</button>
        </>}
      </div>
    </main>
  </>
}
