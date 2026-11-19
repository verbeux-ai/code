/** Convert local turn evidence to booleans only; never retain message content. */
export function hasHumanRequest(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false
  return messages.some(value => {
    if (!value || typeof value !== 'object') return false
    const message = value as { type?: unknown; isMeta?: unknown; isSidechain?: unknown; uuid?: unknown; message?: { content?: unknown } }
    if (message.type !== 'user' || message.isMeta === true || message.isSidechain === true || typeof message.uuid !== 'string') return false
    const content = message.message?.content
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
    return blocks.some(block => {
      if (!block || typeof block !== 'object') return false
      if (block.type === 'image') return true
      if (block.type !== 'text' || typeof block.text !== 'string') return false
      const text = block.text.trim()
      return text.length > 0 && !/^<(?:local-command-stdout|command-message|command-name|bash-input)\b/i.test(text)
    })
  })
}

/** A successful terminal response must have final text, not an error or truncation. */
export function hasCompletedResponse(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const response = value as { type?: unknown; isApiErrorMessage?: unknown; apiError?: unknown; message?: { content?: unknown; stop_reason?: unknown } }
  if (response.type !== 'assistant' || response.isApiErrorMessage || response.apiError ||
    !['end_turn', 'stop_sequence'].includes(String(response.message?.stop_reason))) return false
  return Array.isArray(response.message?.content) && response.message.content.some(block =>
    block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0)
}
