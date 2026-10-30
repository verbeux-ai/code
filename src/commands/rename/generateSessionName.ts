import {
  queryFastModel,
  sideQuerySupportsStructuredOutput,
} from '../../services/api/verbooFastModel.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { safeParseJSON } from '../../utils/json.js'
import { extractTextContent } from '../../utils/messages.js'
import { extractConversationText } from '../../utils/sessionTitle.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'

const SESSION_NAME_INSTRUCTIONS =
  'Generate a short kebab-case name (2-4 words) that captures the main topic of this conversation. Use lowercase words separated by hyphens. Examples: "fix-login-bug", "add-auth-feature", "refactor-api-client", "debug-test-failures".'

const MAX_NAME_WORDS = 6
const MAX_NAME_LENGTH = 60

export type SessionNameResult =
  | { ok: true; name: string }
  | {
      ok: false
      /** no_context: nothing to name yet; failed: the model call failed. */
      reason: 'no_context' | 'failed'
    }

function toKebabCase(value: string): string | null {
  const words = value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, MAX_NAME_WORDS)
  let name = words.join('-')
  if (name.length > MAX_NAME_LENGTH) {
    name = name.slice(0, MAX_NAME_LENGTH).replace(/-[^-]*$/, '')
  }
  return name || null
}

/**
 * Extract a kebab-case name from a model reply: the structured-output JSON
 * (`{"name": "..."}`), JSON embedded in prose, or a plain one-line answer.
 */
export function parseSessionNameResponse(text: string): string | null {
  const raw = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  if (!raw) return null

  const parsed = safeParseJSON(raw, false)
  if (
    parsed &&
    typeof parsed === 'object' &&
    typeof (parsed as { name?: unknown }).name === 'string'
  ) {
    return toKebabCase((parsed as { name: string }).name)
  }

  const embedded = /"name"\s*:\s*"([^"]*)"/.exec(raw)
  if (embedded?.[1]) return toKebabCase(embedded[1])

  const lines = raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  const firstLine = lines.find(line => !line.endsWith(':')) ?? lines[0]
  if (!firstLine) return null
  return toKebabCase(firstLine.replace(/^(?:session\s+)?name\s*:\s*/i, ''))
}

async function requestSessionName(
  conversationText: string,
  signal: AbortSignal,
): Promise<string> {
  const options = {
    querySource: 'rename_generate_name' as const,
    agents: [],
    isNonInteractiveSession: false,
    hasAppendSystemPrompt: false,
    mcpTools: [],
  }

  // The Verboo router rejects structured output (`output_format`) for most
  // plans, so for router models ask for the bare name and parse the text.
  const structured = sideQuerySupportsStructuredOutput()
  const result = await queryFastModel({
    systemPrompt: asSystemPrompt([
      structured
        ? `${SESSION_NAME_INSTRUCTIONS} Return JSON with a "name" field.`
        : `${SESSION_NAME_INSTRUCTIONS} Reply with the name only: no quotes, no explanation.`,
    ]),
    userPrompt: conversationText,
    outputFormat: structured
      ? {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
            },
            required: ['name'],
            additionalProperties: false,
          },
        }
      : undefined,
    signal,
    options,
  })

  return extractTextContent(result.message.content)
}

export async function generateSessionNameResult(
  messages: Message[],
  signal: AbortSignal,
): Promise<SessionNameResult> {
  const conversationText = extractConversationText(messages)
  if (!conversationText) {
    return { ok: false, reason: 'no_context' }
  }

  try {
    const name = parseSessionNameResponse(
      await requestSessionName(conversationText, signal),
    )
    return name ? { ok: true, name } : { ok: false, reason: 'failed' }
  } catch (error) {
    // Haiku timeout/rate-limit/network are expected operational failures —
    // logForDebugging, not logError. Called automatically on every 3rd bridge
    // message (initReplBridge.ts), so errors here would flood the error file.
    logForDebugging(`generateSessionName failed: ${errorMessage(error)}`, {
      level: 'error',
    })
    return { ok: false, reason: 'failed' }
  }
}

export async function generateSessionName(
  messages: Message[],
  signal: AbortSignal,
): Promise<string | null> {
  const result = await generateSessionNameResult(messages, signal)
  return result.ok ? result.name : null
}
