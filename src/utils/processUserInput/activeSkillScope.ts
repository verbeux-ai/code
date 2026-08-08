import type { Message } from '../../types/message.js'
import type { EffortValue } from '../effort.js'

export type ActiveSkillScope = {
  allowedTools: string[]
  model?: string
  effort?: EffortValue
}

/**
 * Background task notifications continue the workflow that launched the task.
 * Recover the most recent inline skill scope so the notification turn keeps
 * the skill's model, effort, and tool permissions instead of silently falling
 * back to the session defaults.
 *
 * A later visible user prompt ends the scope. This prevents an old background
 * task from reviving a skill after the user has moved on to another request.
 */
export function getActiveSkillScopeForQueuedContinuation(
  messages: Message[],
  mode: string | undefined,
): ActiveSkillScope | null {
  if (mode !== 'task-notification') return null

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message) continue

    if (
      message.type === 'attachment' &&
      message.attachment?.type === 'command_permissions'
    ) {
      return {
        allowedTools: message.attachment.allowedTools ?? [],
        model: message.attachment.model,
        effort: message.attachment.effort,
      }
    }

    if (
      message.type === 'user' &&
      !message.isMeta &&
      message.origin?.kind !== 'task-notification'
    ) {
      return null
    }
  }

  return null
}
