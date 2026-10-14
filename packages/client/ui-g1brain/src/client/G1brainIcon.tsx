/** Decorative icon for the workbench sidebar entry. */
import { IconDatabaseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** Render the sidebar icon at the size requested by its owner. */
export function G1brainIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconDatabaseOutlineRegular size={size} />
}
