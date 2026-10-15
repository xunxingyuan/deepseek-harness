/** G1brain Session preparation with stage-specific failures. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { G1brainSessionTarget } from '@deepseek-ai/dsh-g1brain-integration/types'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    g1brainPreparation: unknown
  }
}

/** Failure stages in the G1brain Session preparation flow. */
export type G1brainPreparationStage = 'directory' | 'session' | 'binding' | 'draft'

/** Carries the failed preparation stage without exposing backend diagnostics as product copy. */
export class G1brainPreparationError extends Error {
  constructor(readonly stage: G1brainPreparationStage, cause: unknown) {
    super(`G1brain Session preparation failed at ${stage}`, { cause })
    this.name = 'G1brainPreparationError'
  }
}

/** Attribute a failure to the operation that produced it.
 * @param stage - preparation operation shown by the caller's localized error notice.
 * @param operation - operation whose result is preserved on success.
 * @returns the operation result, or a stage-specific preparation error.
 */
async function preparationStep<T>(stage: G1brainPreparationStage, operation: () => T | Promise<T>): Promise<T> {
  try { return await operation() }
  catch (error) { throw new G1brainPreparationError(stage, error) }
}
/** Prepare the selected targets and draft before navigating into a G1brain Session.
 * @param ctx - the feature's injected Client services.
 * @param input - selected materials, targets, and user-editable operation brief.
 * @returns after the bound Session is ready and opened; failures carry their preparation stage.
 */
export async function prepareG1brainSession(ctx: Context, input: { target: G1brainSessionTarget; prompt: string }): Promise<void> {
  const { target, prompt } = input
  const workspace = await preparationStep('directory', () => ctx.workspaces.create({ path: target.folderPath }))
  const sessionId = await preparationStep('session', () => ctx.sessions.create({ workspaceId: workspace.workspaceId }))
  await preparationStep('binding', async () => {
    const result = await ctx.remote.g1brain.bindSession({ sessionId, target })
    if (!result.ok) throw new Error(result.error.message)
  })
  await preparationStep('draft', async () => {
    const reference = ctx.sessions.retain(sessionId, { source: 'g1brainPreparation' })
    try {
      await reference.ready
      if (ctx.conversation.input.requestDraftInitialization(reference.binding, { prompt }) !== 'applied') {
        throw new Error('G1brain Session draft could not be prepared')
      }
      ctx.uiWorkspace.openSession(sessionId)
    } finally {
      reference.release()
    }
  })
}
