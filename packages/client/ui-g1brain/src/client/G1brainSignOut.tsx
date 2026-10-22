/** Desktop-only sign-out action in the sidebar footer, available from every workspace panel. */
import { useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './G1brainSignOut.module.css'

/** Native main-process action; confirmation and credential cleanup do not run in the browser. */
export interface G1brainSignOutInjected {
  readonly signOut: () => Promise<boolean>
}

type Props = PropsRuntime<'sidebar.footer.action'> & PropsLocale<'g1brain'> & InjectFace<G1brainSignOutInjected>

/** Render a labeled sign-out action with a compact icon when the sidebar is collapsed.
 * @param props - sidebar geometry, locale, and native sign-out callback.
 * @returns the footer action and safe retry message when native sign-out fails.
 */
export function G1brainSignOut({ wide, t, signOut }: Props) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const pending = useRef(false)
  const run = async () => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setFailed(false)
    try { await signOut() }
    catch (_nativeFailure: unknown) { setFailed(true) }
    finally { pending.current = false; setBusy(false) }
  }
  return <div className={css.root}>
    <button type="button" className={wide ? css.button : css.compact} title={t('signOut')} aria-label={t('signOut')}
      disabled={busy} onClick={() => { void run() }}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <path d="M10 4H5v16h5M9 12h12m-4-4 4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {wide && <span>{t(busy ? 'signingOut' : 'signOut')}</span>}
    </button>
    {failed && <small role="alert">{t('signOutFailed')}</small>}
  </div>
}
