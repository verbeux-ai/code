/**
 * Session title generation via Haiku.
 *
 * Standalone module with minimal dependencies so it can be imported from
 * print.ts (SDK control request handler) without pulling in the React/chalk/
 * git dependency chain that teleport.tsx carries.
 *
 * This is the single source of truth for AI-generated session titles across
 * all surfaces. Previously there were separate Haiku title generators:
 * - teleport.tsx generateTitleAndBranch (6-word title + branch for CCR)
 * - rename/generateSessionName.ts (kebab-case name for /rename)
 * Each remains for backwards compat; new callers should use this module.
 */

import { z } from 'zod/v4'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { logEvent } from '../services/analytics/index.js'
import {
  queryFastModel,
  sideQuerySupportsStructuredOutput,
} from '../services/api/verbooFastModel.js'
import type { Message } from '../types/message.js'
import { logForDebugging } from './debug.js'
import { stripDisplayTagsAllowEmpty } from './displayTags.js'
import { safeParseJSON } from './json.js'
import { lazySchema } from './lazySchema.js'
import { extractTextContent } from './messages.js'
import { asSystemPrompt } from './systemPromptType.js'

const MAX_CONVERSATION_TEXT = 1000

/**
 * Flatten a message array into a single text string for Haiku title input.
 * Skips meta/non-human messages. Tail-slices to the last 1000 chars so
 * recent context wins when the conversation is long.
 */
export function extractConversationText(messages: Message[]): string {
  const parts: string[] = []
  for (const msg of messages) {
    if (msg.type !== 'user' && msg.type !== 'assistant') continue
    if ('isMeta' in msg && msg.isMeta) continue
    if ('origin' in msg && msg.origin && msg.origin.kind !== 'human') continue
    const content = msg.message.content
    if (typeof content === 'string') {
      parts.push(content)
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if ('type' in block && block.type === 'text' && 'text' in block) {
          parts.push(block.text as string)
        }
      }
    }
  }
  const text = parts.join('\n')
  return text.length > MAX_CONVERSATION_TEXT
    ? text.slice(-MAX_CONVERSATION_TEXT)
    : text
}

const SESSION_TITLE_PROMPT = `Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of this coding session. The title should be clear enough that the user recognizes the session in a list. Use sentence case: capitalize only the first word and proper nouns. Write the title in the same language as the user's message.

Return JSON with a single "title" field.

Good examples:
{"title": "Fix login button on mobile"}
{"title": "Add OAuth authentication"}
{"title": "Debug failing CI tests"}
{"title": "Refactor API client error handling"}

Bad (too vague): {"title": "Code changes"}
Bad (too long): {"title": "Investigate and fix the issue where the login button does not respond on mobile devices"}
Bad (wrong case): {"title": "Fix Login Button On Mobile"}`

// For the Verboo router: it rejects `output_format` (structured output) for
// most plans with 403 structured_output_not_enabled, so ask for the bare title
// and parse whatever comes back.
const SESSION_TITLE_PROMPT_TEXT = `Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of this coding session. The title should be clear enough that the user recognizes the session in a list. Use sentence case: capitalize only the first word and proper nouns. Write the title in the same language as the user's message.

Reply with the title text only: no quotes, no label, no trailing punctuation, no explanation.

Good examples:
Fix login button on mobile
Add OAuth authentication
Debug failing CI tests
Refactor API client error handling

Bad (too vague): Code changes
Bad (too long): Investigate and fix the issue where the login button does not respond on mobile devices
Bad (wrong case): Fix Login Button On Mobile`

const titleSchema = lazySchema(() => z.object({ title: z.string() }))

const MAX_GENERATED_TITLE_LENGTH = 80
const MAX_FALLBACK_TITLE_LENGTH = 60

function truncateTitle(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  const slice = text.slice(0, maxLength - 1)
  const lastSpace = slice.lastIndexOf(' ')
  const cut = lastSpace > maxLength / 2 ? slice.slice(0, lastSpace) : slice
  return cut.trimEnd() + '\u2026'
}

function cleanTitleText(value: string | undefined): string | null {
  if (!value) return null
  const cleaned = value
    .replace(/\s+/g, ' ')
    .trim()
    // Markdown heading / list / quote / emphasis markers
    .replace(/^[#>*\-\s]+/, '')
    .replace(/\*+$/, '')
    // "Title: ..." / "Title - ..." style labels
    .replace(/^(?:session\s+)?(?:title|t[ií]tulo)\s*(?::|\s[-\u2013\u2014])\s*/i, '')
    .replace(/^["'`\u201c\u201d\u2018\u2019]+|["'`\u201c\u201d\u2018\u2019]+$/g, '')
    .replace(/[.\u3002]+$/, '')
    .trim()
  if (!cleaned) return null
  return truncateTitle(cleaned, MAX_GENERATED_TITLE_LENGTH)
}

/**
 * Extract a title from a model reply. Accepts the structured-output JSON
 * (`{"title": "..."}`), JSON wrapped in prose or code fences, or a plain
 * one-line title. Inline `<think>` reasoning is ignored.
 */
export function parseSessionTitleResponse(text: string): string | null {
  const raw = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  if (!raw) return null

  const parsed = titleSchema().safeParse(safeParseJSON(raw, false))
  if (parsed.success) return cleanTitleText(parsed.data.title)

  const embedded = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)
  if (embedded?.[1] !== undefined) {
    const decoded = safeParseJSON(`"${embedded[1]}"`, false)
    return cleanTitleText(
      typeof decoded === 'string' ? decoded : embedded[1],
    )
  }

  // Plain text: first non-empty line, skipping a lead-in such as
  // "Here is a title:".
  const lines = raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  const firstLine = lines.find(line => !line.endsWith(':')) ?? lines[0]
  return cleanTitleText(firstLine)
}

/**
 * Title used when generation fails: the user's own first prompt, cleaned of
 * system-injected tags and flattened to one line. Mirrors what /resume shows
 * for untitled sessions, so a failure never surfaces a generic product name.
 */
export function deriveFallbackSessionTitle(description: string): string | null {
  const flat = stripDisplayTagsAllowEmpty(description).replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return truncateTitle(flat, MAX_FALLBACK_TITLE_LENGTH)
}

export type SessionTitleResult = {
  title: string
  /** 'model' when the model produced it; 'fallback' when derived from input. */
  source: 'model' | 'fallback'
}

async function requestSessionTitle(
  description: string,
  signal: AbortSignal,
): Promise<string> {
  const options = {
    querySource: 'generate_session_title' as const,
    agents: [],
    // Reflect the actual session mode — this module is called from
    // both the SDK print path (non-interactive) and the CCR remote
    // session path via useRemoteSession (interactive).
    isNonInteractiveSession: getIsNonInteractiveSession(),
    hasAppendSystemPrompt: false,
    mcpTools: [],
  }

  const structured = sideQuerySupportsStructuredOutput()
  const result = await queryFastModel({
    systemPrompt: asSystemPrompt([
      structured ? SESSION_TITLE_PROMPT : SESSION_TITLE_PROMPT_TEXT,
    ]),
    userPrompt: description,
    outputFormat: structured
      ? {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              title: { type: 'string' },
            },
            required: ['title'],
            additionalProperties: false,
          },
        }
      : undefined,
    signal,
    options,
  })

  return extractTextContent(result.message.content)
}

/**
 * Generate a sentence-case session title from a description or first message
 * and report whether the model produced it. Never rejects: on any failure it
 * falls back to the cleaned description. Returns null only for empty input.
 */
export async function generateSessionTitleWithSource(
  description: string,
  signal: AbortSignal,
): Promise<SessionTitleResult | null> {
  const trimmed = description.trim()
  if (!trimmed) return null

  let title: string | null = null
  try {
    title = parseSessionTitleResponse(
      await requestSessionTitle(trimmed, signal),
    )
  } catch (error) {
    logForDebugging(`generateSessionTitle failed: ${error}`, {
      level: 'error',
    })
  }

  logEvent('tengu_session_title_generated', { success: title !== null })
  if (title) return { title, source: 'model' }

  const fallback = deriveFallbackSessionTitle(trimmed)
  return fallback ? { title: fallback, source: 'fallback' } : null
}

/**
 * Generate a sentence-case session title from a description or first message.
 * Falls back to the cleaned description when the model call fails or returns
 * nothing usable; returns null only for empty input.
 *
 * @param description - The user's first message or a description of the session
 * @param signal - Abort signal for cancellation
 */
export async function generateSessionTitle(
  description: string,
  signal: AbortSignal,
): Promise<string | null> {
  return (await generateSessionTitleWithSource(description, signal))?.title ?? null
}
