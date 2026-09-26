import type { NormalizedMessage, RenderableMessage } from '../types/message.js'
import { getDisplayMessageFromCollapsed } from './collapseReadSearch.js'

// Thinking, redacted thinking and whitespace-only blocks do not own a model
// header. Keeping this predicate shared also avoids empty metadata wrappers.
export function hasVisibleModelContent(message: NormalizedMessage): boolean {
  return message.type === 'assistant' && message.message.content.some(
    (block: { type: string; text?: string }) =>
      (block.type === 'text' && !!block.text?.trim()) ||
      block.type === 'tool_use',
  )
}

function displayMessage(message: RenderableMessage): NormalizedMessage {
  if (message.type === 'grouped_tool_use') return message.displayMessage
  if (message.type === 'collapsed_read_search') return getDisplayMessageFromCollapsed(message)
  return message
}

// Compute ownership before viewport slicing. Scrolling, chunked transcript
// exports and resume must not assign another header to a later content block.
export function routingModelHeaderOwners(messages: RenderableMessage[]): Set<string> {
  const owners = new Set<string>()
  const completions = new Set<string>()
  for (const row of messages) {
    const message = displayMessage(row)
    if (!hasVisibleModelContent(message) ||
      typeof message.message.metadata?.selected_model !== 'string') continue
    const completion = JSON.stringify([
      message.requestId ?? null,
      message.message.id || message.uuid,
    ])
    if (completions.has(completion)) continue
    completions.add(completion)
    owners.add(row.uuid)
  }
  return owners
}
