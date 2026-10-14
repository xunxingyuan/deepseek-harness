/** Compact G1brain brand in the existing sidebar identity slots. */
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './G1brainBrand.module.css'

/** Render the three-bar G1brain mark. */
export function G1brainBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <span className={css.mark} style={{ width: size, height: size }} aria-hidden="true"><i /><i /><i /></span>
}

/** Render the desktop brand name. */
export function G1brainBrandName({ t }: PropsLocale<'g1brain'>) {
  return <span className={css.name}>{t('brand')}</span>
}
