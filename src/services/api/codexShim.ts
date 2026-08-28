import { APIError } from '@anthropic-ai/sdk'
import { resolveToolNameByUniquePrefix } from '../../Tool.js'
import { buildAnthropicUsageFromRawUsage } from './cacheMetrics.js'
import { compressToolHistory } from './compressToolHistory.js'
import { fetchWithProxyRetry } from './fetchWithProxyRetry.js'
import { stableStringifyJson } from '../../utils/stableStringify.js'
import type {
  ResolvedCodexCredentials,
  ResolvedProviderRequest,
} from './providerConfig.js'
import { sanitizeSchemaForOpenAICompat } from './openaiSchemaSanitizer.js'
import {
  hasInvalidUnicodeScalar,
  hasInvalidUnicodeScalarDeep,
} from './openaiProtocolReliability.js'
import {
  createThinkTagFilter,
  stripThinkTags,
} from './thinkTagSanitizer.js'
import {
  BoundedResponseBodyError,
  readBoundedResponseText,
} from './boundedResponseBody.js'

export interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

export interface AnthropicStreamEvent {
  type: string
  message?: Record<string, unknown>
  index?: number
  content_block?: Record<string, unknown>
  delta?: Record<string, unknown>
  usage?: Partial<AnthropicUsage>
}

export interface ShimCreateParams {
  model: string
  messages: Array<Record<string, unknown>>
  system?: unknown
  tools?: Array<Record<string, unknown>>
  max_tokens: number
  stream?: boolean
  temperature?: number
  top_p?: number
  tool_choice?: unknown
  metadata?: unknown
  [key: string]: unknown
}

type ResponsesInputPart =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string }

type ResponsesInputItem =
  | {
      type: 'message'
      role: 'user' | 'assistant'
      content: ResponsesInputPart[]
    }
  | {
      type: 'function_call'
      id: string
      call_id: string
      name: string
      arguments: string
    }
  | {
      type: 'function_call_output'
      call_id: string
      output: string
    }

type ResponsesTool = {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
  strict?: boolean
}

const DEFAULT_MAX_BUFFERED_TOOL_ARGUMENT_CHARS = 8 * 1024 * 1024
const HARD_MAX_BUFFERED_TOOL_ARGUMENT_CHARS = 8 * 1024 * 1024
const MAX_CODEX_ACTIVE_TOOL_CALLS = 128
const MAX_CODEX_TOOL_ID_OR_NAME_CHARS = 512
const MAX_CODEX_SSE_LINE_BUFFER_CHARS = 4 * 1024 * 1024
const MAX_CODEX_SSE_READ_CHUNK_BYTES = 8 * 1024 * 1024
const MAX_CODEX_VISIBLE_TEXT_CHARS = 8 * 1024 * 1024
const MAX_CODEX_ERROR_BODY_BYTES = 1024 * 1024

function maxBufferedToolArgumentChars(): number {
  const raw = process.env.VERBOO_MAX_BUFFERED_TOOL_ARGUMENT_CHARS
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, HARD_MAX_BUFFERED_TOOL_ARGUMENT_CHARS)
    : DEFAULT_MAX_BUFFERED_TOOL_ARGUMENT_CHARS
}

type CodexSseEvent = {
  event: string
  data: Record<string, any>
}

function parseCompletedCodexTool(item: Record<string, any>): {
  input: Record<string, unknown>
  toolUseId: string
} {
  if (
	  typeof item.name !== 'string' ||
	  !item.name ||
	  hasInvalidUnicodeScalar(item.name) ||
	  item.name.length > MAX_CODEX_TOOL_ID_OR_NAME_CHARS ||
    typeof item.arguments !== 'string' ||
    item.arguments.length > maxBufferedToolArgumentChars()
  ) {
    throw new Error(
      'Codex completed response contained a malformed tool call; no tool was committed',
    )
  }
  for (const key of ['id', 'call_id'] as const) {
    const value = item[key]
	if (
	  value != null &&
	  (typeof value !== 'string' ||
		!value.trim() ||
		hasInvalidUnicodeScalar(value) ||
		value.length > MAX_CODEX_TOOL_ID_OR_NAME_CHARS)
	) {
      throw new Error(
        'Codex completed response contained a malformed tool call ID; no tool was committed',
      )
    }
  }
  const rawToolUseId = item.call_id ?? item.id
  if (typeof rawToolUseId !== 'string' || !rawToolUseId.trim()) {
    throw new Error(
      'Codex completed response omitted its tool call ID; no tool was committed',
    )
  }
  let input: unknown
  try {
    input = JSON.parse(item.arguments)
  } catch {
    throw new Error(
      'Codex completed response contained invalid tool arguments; no tool was committed',
    )
  }
  if (hasInvalidUnicodeScalarDeep(input)) {
    throw new Error(
      'Codex completed response contained tool arguments with an invalid Unicode scalar; no tool was committed',
    )
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(
      'Codex completed response contained non-object tool arguments; no tool was committed',
    )
  }
  return {
    input: input as Record<string, unknown>,
    toolUseId: rawToolUseId,
  }
}

function parseCodexSseEventChunk(chunk: string): CodexSseEvent | undefined {
  const lines = chunk
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return undefined

  const eventLine = lines.find(line => line.startsWith('event:'))
  const dataLines = lines.filter(line => line.startsWith('data:'))
  if (dataLines.length === 0) return undefined

  const rawData = dataLines
    .map(line => line.slice('data:'.length).trimStart())
    .join('\n')
  if (rawData === '[DONE]') return undefined

  let data: Record<string, any>
  try {
    const parsed = JSON.parse(rawData)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Codex SSE data was not a JSON object')
    }
    data = parsed as Record<string, any>
  } catch (error) {
    throw new Error(
      'Codex SSE emitted invalid JSON; the response was not committed',
      { cause: error },
    )
  }
  if (hasInvalidUnicodeScalarDeep(data)) {
    throw new Error(
      'Codex SSE contained an invalid Unicode scalar; the response was not committed',
    )
  }

  const framedEvent = eventLine?.slice('event:'.length).trim() ?? ''
  const payloadEvent = typeof data.type === 'string' ? data.type : ''
  if (framedEvent && payloadEvent && framedEvent !== payloadEvent) {
    throw new Error(
      'Codex SSE event name contradicted its payload type; no tool was committed',
    )
  }
  const event = framedEvent || payloadEvent
  if (!event) {
    throw new Error(
      'Codex SSE data omitted its event type; the response was not committed',
    )
  }
  return { event, data }
}

function completedCodexVisibleText(response: Record<string, any>): string {
  const output = Array.isArray(response.output) ? response.output : []
  let visible = ''
  for (const item of output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue
    for (const part of item.content) {
      if (part?.type === 'output_text' && typeof part.text === 'string') {
        visible += stripThinkTags(part.text)
      }
    }
  }
  return visible
}

function requireCodexTerminalResponse(
  payload: Record<string, any>,
  expectedStatus: 'completed' | 'incomplete',
): Record<string, any> {
  const response = payload?.response
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error(
      `Codex response.${expectedStatus} omitted its response object; the response was not committed`,
    )
  }
  if (response.status !== expectedStatus) {
    throw new Error(
      `Codex response.${expectedStatus} carried a missing or contradictory status; the response was not committed`,
    )
  }
  if (typeof response.id !== 'string' || !response.id.trim()) {
    throw new Error(
      `Codex response.${expectedStatus} omitted its response ID; the response was not committed`,
    )
  }
  if (!Array.isArray(response.output)) {
    throw new Error(
      `Codex response.${expectedStatus} omitted its output array; the response was not committed`,
    )
  }
  return response
}

function makeUsage(usage?: Record<string, unknown>): AnthropicUsage {
  // Single source of truth for raw → Anthropic shape. Lives in
  // cacheMetrics.ts alongside the raw-shape extractor so any new
  // provider quirk requires a one-file change and the integration test
  // can call the exact same function instead of re-implementing it.
  return buildAnthropicUsageFromRawUsage(usage)
}

function makeMessageId(): string {
  return `msg_${crypto.randomUUID().replace(/-/g, '')}`
}

function normalizeToolUseId(toolUseId: string | undefined): {
  id: string
  callId: string
} {
  const value = (toolUseId || '').trim()
  if (!value) {
    return {
      id: 'fc_unknown',
      callId: 'call_unknown',
    }
  }
  if (value.startsWith('call_')) {
    return {
      id: `fc_${value.slice('call_'.length)}`,
      callId: value,
    }
  }
  if (value.startsWith('fc_')) {
    return {
      id: value,
      callId: `call_${value.slice('fc_'.length)}`,
    }
  }
  return {
    id: `fc_${value}`,
    callId: value,
  }
}

export function convertSystemPrompt(system: unknown): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system
      .map((block: { type?: string; text?: string }) =>
        block.type === 'text' ? (block.text ?? '') : '',
      )
      // Drop the Anthropic billing/attribution block — Codex's Responses API
      // doesn't parse it and the per-build fingerprint just churns the
      // upstream prompt cache.
      .filter(text => !text.startsWith('x-anthropic-billing-header'))
      .join('\n\n')
  }
  return String(system)
}

function convertToolResultToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content ?? '')

  const chunks: string[] = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      chunks.push(block.text)
      continue
    }

    if (block?.type === 'image') {
      const src = block.source
      if (src?.type === 'url' && src.url) {
        chunks.push(`[Image](${src.url})`)
      }
      continue
    }

    if (typeof block?.text === 'string') {
      chunks.push(block.text)
    }
  }

  return chunks.join('\n')
}

function convertContentBlocksToResponsesParts(
  content: unknown,
  role: 'user' | 'assistant',
): ResponsesInputPart[] {
  const textType = role === 'assistant' ? 'output_text' : 'input_text'
  if (typeof content === 'string') {
    return [{ type: textType, text: content }]
  }
  if (!Array.isArray(content)) {
    return [{ type: textType, text: String(content ?? '') }]
  }

  const parts: ResponsesInputPart[] = []
  for (const block of content) {
    switch (block?.type) {
      case 'text':
        parts.push({ type: textType, text: block.text ?? '' })
        break
      case 'image': {
        if (role === 'assistant') break
        const source = block.source
        if (source?.type === 'base64') {
          parts.push({
            type: 'input_image',
            image_url: `data:${source.media_type};base64,${source.data}`,
          })
        } else if (source?.type === 'url' && source.url) {
          parts.push({
            type: 'input_image',
            image_url: source.url,
          })
        }
        break
      }
      case 'thinking':
        if (block.thinking) {
          parts.push({
            type: textType,
            text: `<thinking>${block.thinking}</thinking>`,
          })
        }
        break
      case 'tool_use':
      case 'tool_result':
        break
      default:
        if (typeof block?.text === 'string') {
          parts.push({ type: textType, text: block.text })
        }
    }
  }

  return parts
}

export function convertAnthropicMessagesToResponsesInput(
  messages: Array<{ role?: string; message?: { role?: string; content?: unknown }; content?: unknown }>,
): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = []

  for (const message of messages) {
    const inner = message.message ?? message
    const role = (inner as { role?: string }).role ?? message.role
    const content = (inner as { content?: unknown }).content

    if (role === 'user') {
      if (Array.isArray(content)) {
        const toolResults = content.filter(
          (block: { type?: string }) => block.type === 'tool_result',
        )
        const otherContent = content.filter(
          (block: { type?: string }) => block.type !== 'tool_result',
        )

        for (const toolResult of toolResults) {
          const { callId } = normalizeToolUseId(toolResult.tool_use_id)
          items.push({
            type: 'function_call_output',
            call_id: callId,
            output: (() => {
              const out = convertToolResultToText(toolResult.content)
              return toolResult.is_error ? `Error: ${out}` : out
            })(),
          })
        }

        const parts = convertContentBlocksToResponsesParts(otherContent, 'user')
        if (parts.length > 0) {
          items.push({
            type: 'message',
            role: 'user',
            content: parts,
          })
        }
        continue
      }

      items.push({
        type: 'message',
        role: 'user',
        content: convertContentBlocksToResponsesParts(content, 'user'),
      })
      continue
    }

    if (role === 'assistant') {
      const textBlocks = Array.isArray(content)
        ? content.filter((block: { type?: string }) =>
            block.type !== 'tool_use' && block.type !== 'thinking')
        : content
      const parts = convertContentBlocksToResponsesParts(textBlocks, 'assistant')
      if (parts.length > 0) {
        items.push({
          type: 'message',
          role: 'assistant',
          content: parts,
        })
      }

      if (Array.isArray(content)) {
        for (const toolUse of content.filter(
          (block: { type?: string }) => block.type === 'tool_use',
        )) {
          const normalized = normalizeToolUseId(toolUse.id)
          items.push({
            type: 'function_call',
            id: normalized.id,
            call_id: normalized.callId,
            name: toolUse.name ?? 'tool',
            arguments:
              typeof toolUse.input === 'string'
                ? toolUse.input
                : JSON.stringify(toolUse.input ?? {}),
          })
        }
      }
    }
  }

  return items.filter(item =>
    item.type !== 'message' || item.content.length > 0,
  )
}

/**
 * Codex Responses strict mode requires every schema node to declare a `type`.
 * MCP tools sometimes register properties with no `type` (e.g. a generic
 * `value` parameter intended to accept any JSON), which triggers a 400 from
 * the Responses API: `schema must have a 'type' key`. Infer one from sibling
 * keys, fall back to `string` for fully empty nodes, and leave combinator-only
 * schemas alone (their branches carry the real type info).
 */
function ensureSchemaType(record: Record<string, unknown>): void {
  const raw = record.type
  if (typeof raw === 'string') return
  if (Array.isArray(raw) && raw.length > 0) return

  if (record.properties && typeof record.properties === 'object') {
    record.type = 'object'
    return
  }
  if ('items' in record) {
    record.type = 'array'
    return
  }
  if (Array.isArray((record as Record<string, unknown>).anyOf) ||
      Array.isArray((record as Record<string, unknown>).oneOf) ||
      Array.isArray((record as Record<string, unknown>).allOf)) {
    // Combinator-only schemas keep their semantics; forcing a `type` here
    // would silently narrow the alternatives.
    return
  }
  if (Array.isArray(record.enum) && record.enum.length > 0) {
    const sample = typeof record.enum[0]
    if (sample === 'string' || sample === 'boolean') {
      record.type = sample
      return
    }
    if (sample === 'number') {
      record.type = record.enum.every(v => Number.isInteger(v)) ? 'integer' : 'number'
      return
    }
  }
  if ('const' in record) {
    const sample = typeof record.const
    if (sample === 'string' || sample === 'boolean') {
      record.type = sample
      return
    }
    if (sample === 'number') {
      record.type = Number.isInteger(record.const) ? 'integer' : 'number'
      return
    }
  }

  // Permissive default: strict mode demands a concrete type, and `string`
  // round-trips through JSON.stringify for callers that need to forward raw
  // values to the underlying tool.
  record.type = 'string'
}

/**
 * Recursively enforces Codex strict-mode constraints on a JSON schema:
 * - Every `object` type gets `additionalProperties: false`
 * - All property keys are listed in `required`
 * - Nested schemas (properties, items, anyOf/oneOf/allOf) are processed too
 */
function enforceStrictSchema(schema: unknown): Record<string, unknown> {
  const record = sanitizeSchemaForOpenAICompat(schema)

  ensureSchemaType(record)

  // Codex Responses rejects JSON Schema's standard `uri` string format.
  // Keep URL validation in the tool layer and send a plain string here.
  if (record.format === 'uri') {
    delete record.format
  }

  if (record.type === 'object') {
    // OpenAI structured outputs completely forbid dynamic additionalProperties.
    // They must be set to false unconditionally.
    record.additionalProperties = false

    if (
      record.properties &&
      typeof record.properties === 'object' &&
      !Array.isArray(record.properties)
    ) {
      const props = record.properties as Record<string, unknown>

      const enforcedProps: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(props)) {
        const strictValue = enforceStrictSchema(value)
        // If the resulting schema is an empty object (no properties), OpenAI structured outputs will likely
        // strip it silently and then complain about a 'required' mismatch if it remains in the required list.
        // E.g. z.record() objects (like AskUserQuestion.answers) lose their schema due to additionalProperties 
        // restrictions. We can safely drop these from the schema sent to the LLM.
        if (
          strictValue &&
          typeof strictValue === 'object' &&
          strictValue.type === 'object' &&
          strictValue.additionalProperties === false &&
          (!strictValue.properties || Object.keys(strictValue.properties).length === 0)
        ) {
          continue
        }
        enforcedProps[key] = strictValue
      }
      record.properties = enforcedProps
      record.required = Object.keys(enforcedProps)
    } else {
      // No properties — empty object schema with empty required array
      record.properties = {}
      record.required = []
    }
  }

  // Recurse into array items
  if ('items' in record) {
    if (Array.isArray(record.items)) {
      record.items = (record.items as unknown[]).map(item => enforceStrictSchema(item))
    } else {
      record.items = enforceStrictSchema(record.items)
    }
  }

  // Recurse into combinators
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (key in record && Array.isArray(record[key])) {
      record[key] = (record[key] as unknown[]).map(item => enforceStrictSchema(item))
    }
  }

  return record
}

export function convertToolsToResponsesTools(
  tools: Array<{ name?: string; description?: string; input_schema?: Record<string, unknown> }>,
): ResponsesTool[] {
  return tools
    .filter(tool => tool.name && tool.name !== 'ToolSearchTool')
    .map(tool => {
      const rawParameters = tool.input_schema ?? { type: 'object', properties: {} }
      // Codex requires strict schemas: all properties must be required
      const parameters = enforceStrictSchema(rawParameters)

      return {
        type: 'function',
        name: tool.name ?? 'tool',
        description: tool.description ?? '',
        parameters,
        strict: true,
      }
    })
}

function isStrictResponsesSchema(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return true
  }

  const record = schema as Record<string, unknown>
  const type = record.type

  if (type === 'object') {
    const properties =
      record.properties && typeof record.properties === 'object' && !Array.isArray(record.properties)
        ? (record.properties as Record<string, unknown>)
        : {}

    const propertyKeys = Object.keys(properties)
    const required = Array.isArray(record.required)
      ? record.required.filter((value): value is string => typeof value === 'string')
      : null

    if (propertyKeys.length > 0) {
      if (!required) return false

      const requiredSet = new Set(required)
      for (const key of propertyKeys) {
        if (!requiredSet.has(key)) {
          return false
        }
      }
    }

    for (const child of Object.values(properties)) {
      if (!isStrictResponsesSchema(child)) {
        return false
      }
    }
  }

  const combinators = ['anyOf', 'oneOf', 'allOf'] as const
  for (const key of combinators) {
    if (key in record) {
      const value = record[key]
      if (!Array.isArray(value) || value.some(item => !isStrictResponsesSchema(item))) {
        return false
      }
    }
  }

  if ('items' in record) {
    const items = record.items
    if (Array.isArray(items)) {
      return items.every(item => isStrictResponsesSchema(item))
    }
    return isStrictResponsesSchema(items)
  }

  return true
}

function convertToolChoice(toolChoice: unknown): unknown {
  const choice = toolChoice as { type?: string; name?: string } | undefined
  if (!choice?.type) return undefined
  if (choice.type === 'auto') return 'auto'
  if (choice.type === 'any') return 'required'
  if (choice.type === 'none') return 'none'
  if (choice.type === 'tool' && choice.name) {
    return {
      type: 'function',
      name: choice.name,
    }
  }
  return undefined
}

export async function performCodexRequest(options: {
  request: ResolvedProviderRequest
  credentials: ResolvedCodexCredentials
  params: ShimCreateParams
  defaultHeaders: Record<string, string>
  signal?: AbortSignal
}): Promise<Response> {
  const compressedMessages = compressToolHistory(
    options.params.messages as Array<{
      role?: string
      message?: { role?: string; content?: unknown }
      content?: unknown
    }>,
    options.request.resolvedModel,
  )
  const input = convertAnthropicMessagesToResponsesInput(compressedMessages)
  const body: Record<string, unknown> = {
    model: options.request.resolvedModel,
    input: input.length > 0
      ? input
      : [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '' }],
          },
        ],
    store: false,
    stream: true,
  }

  const instructions = convertSystemPrompt(options.params.system)
  if (instructions) {
    body.instructions = instructions
  }

  const toolChoice = convertToolChoice(options.params.tool_choice)
  if (toolChoice) {
    body.tool_choice = toolChoice
  }

  if (options.params.tools && options.params.tools.length > 0) {
    const convertedTools = convertToolsToResponsesTools(
      options.params.tools as Array<{
        name?: string
        description?: string
        input_schema?: Record<string, unknown>
      }>,
    )
    if (convertedTools.length > 0) {
      body.tools = convertedTools
      body.parallel_tool_calls = true
      body.tool_choice ??= 'auto'
    }
  }

  if (options.request.reasoning) {
    body.reasoning = options.request.reasoning
  }

  const isTargetModel =
    options.request.resolvedModel?.toLowerCase().includes('gpt') ||
    options.request.resolvedModel?.toLowerCase().includes('codex')

  // Only pass temperature and top_p if it's not a GPT/Codex model that rejects them
  if (!isTargetModel) {
    if (options.params.temperature !== undefined) {
      body.temperature = options.params.temperature
    }
    if (options.params.top_p !== undefined) {
      body.top_p = options.params.top_p
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.defaultHeaders,
    Authorization: `Bearer ${options.credentials.apiKey}`,
  }
  if (options.credentials.accountId) {
    headers['chatgpt-account-id'] = options.credentials.accountId
  }
  headers.originator ??= 'verboo'

  const response = await fetchWithProxyRetry(
    `${options.request.baseUrl}/responses`,
    {
      method: 'POST',
      headers,
      // WHY: byte-identity required for implicit prefix caching on
      // OpenAI Responses API. See src/utils/stableStringify.ts.
      body: stableStringifyJson(body),
      signal: options.signal,
    },
  )

  if (!response.ok) {
    const errorBody = await readBoundedResponseText(
      response,
      MAX_CODEX_ERROR_BODY_BYTES,
    ).catch(error =>
      error instanceof BoundedResponseBodyError
        ? `[provider error body ${error.failure}]`
        : '[provider error body unreadable]',
    )
    let errorResponse: object | undefined
    try { errorResponse = JSON.parse(errorBody) } catch { /* raw text */ }
    throw APIError.generate(
      response.status, errorResponse,
      `Codex API error ${response.status}: ${errorBody}`,
      response.headers as unknown as Headers,
    )
  }

  return response
}

async function* readSseEvents(response: Response, signal?: AbortSignal): AsyncGenerator<CodexSseEvent> {
  const responseBody = response.body
  if (!responseBody) return
  const reader = responseBody.getReader()
  type ReaderResult = Awaited<ReturnType<typeof reader.read>>

  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  const STREAM_IDLE_TIMEOUT_MS = (() => {
    const raw = process.env.VERBOO_STREAM_IDLE_TIMEOUT_MS
    const parsed = raw ? parseInt(raw, 10) : NaN
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000
  })()
  let lastDataTime = Date.now()
  let pendingReaderCancellation: Promise<void> | undefined
  let reachedEOF = false
  let sawTerminalEvent = false
  let terminalGraceDeadline: number | undefined

  const isTerminalEvent = (event: string): boolean =>
    event === 'response.completed' ||
    event === 'response.incomplete' ||
    event === 'response.failed'

  const cancelReader = (reason: unknown): void => {
    if (pendingReaderCancellation) return
    pendingReaderCancellation = reader.cancel(reason).then(
      () => undefined,
      () => undefined,
    )
  }

  /**
   * Read from the stream with an idle timeout. Respects the caller's
   * AbortSignal — clears the idle timer on abort so the AbortError
   * surfaces cleanly instead of a spurious idle timeout.
   */
  async function readWithTimeout(
    timeoutMs = STREAM_IDLE_TIMEOUT_MS,
    timeoutCompletesStream = false,
  ): Promise<ReaderResult> {
    return new Promise((resolve, reject) => {
      let settled = false
      let abortCleanup: (() => void) | undefined
      const cleanup = () => {
        clearTimeout(timeoutId)
        if (signal && abortCleanup) signal.removeEventListener('abort', abortCleanup)
      }
      const resolveOnce = (result: ReaderResult) => {
        if (settled) return
        settled = true
        cleanup()
        if (result.value) lastDataTime = Date.now()
        resolve(result)
      }
      const rejectOnce = (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const timeoutId = setTimeout(() => {
        const elapsed = Math.round((Date.now() - lastDataTime) / 1000)
        const timeoutError = new Error(
          `Codex SSE stream idle for ${elapsed}s (limit: ${timeoutMs / 1000}s). Connection likely dropped.`,
        )
        cancelReader(timeoutError)
        if (timeoutCompletesStream) {
          resolveOnce({ done: true, value: undefined })
        } else {
          rejectOnce(timeoutError)
        }
      }, timeoutMs)

      if (signal) {
        abortCleanup = () => {
          const abortError =
            signal.reason instanceof Error
              ? signal.reason
              : Object.assign(new Error('The operation was aborted'), {
                  name: 'AbortError',
                })
          cancelReader(abortError)
          rejectOnce(abortError)
        }
        if (signal.aborted) {
          abortCleanup()
          return
        }
        signal.addEventListener('abort', abortCleanup, { once: true })
      }

      reader.read().then(resolveOnce, rejectOnce)
    })
  }

  try {
    while (true) {
      let readResult: ReaderResult
      if (sawTerminalEvent) {
        const remaining = (terminalGraceDeadline ?? Date.now()) - Date.now()
        if (remaining <= 0) {
          cancelReader('Codex SSE terminal grace elapsed')
          readResult = { done: true, value: undefined }
        } else {
          readResult = await readWithTimeout(remaining, true)
        }
      } else {
        readResult = await readWithTimeout()
      }
      const { done, value } = readResult
      if (done) {
		reachedEOF = !sawTerminalEvent
		try {
		  buffer += decoder.decode()
		} catch (error) {
		  throw new Error(
		    'Codex SSE contained invalid UTF-8; the response was not committed',
		    { cause: error },
		  )
		}
		if (buffer.length > MAX_CODEX_SSE_LINE_BUFFER_CHARS) {
		  throw new Error(
		    'Codex SSE line exceeded the client safety limit; the response was not committed',
		  )
		}
		if (sawTerminalEvent && buffer.length > 0) {
		  throw new Error(
			'Codex SSE emitted bytes after its terminal event; the late output was not committed',
		  )
		}
		const finalEvent = parseCodexSseEventChunk(buffer)
		if (finalEvent) {
		  yield finalEvent
		  if (isTerminalEvent(finalEvent.event)) {
			sawTerminalEvent = true
			terminalGraceDeadline ??= Date.now() + 250
		  }
		}
        break
      }

	  if (value.byteLength > MAX_CODEX_SSE_READ_CHUNK_BYTES) {
		throw new Error(
		  'Codex SSE transport chunk exceeded the client safety limit; the response was not committed',
		)
	  }
	  try {
		buffer += decoder.decode(value, { stream: true })
	  } catch (error) {
		throw new Error(
		  'Codex SSE contained invalid UTF-8; the response was not committed',
		  { cause: error },
		)
	  }
      const chunks = buffer.split(/\r?\n\r?\n/)
      buffer = chunks.pop() ?? ''
	  if (
		buffer.length > MAX_CODEX_SSE_LINE_BUFFER_CHARS ||
		chunks.some(chunk => chunk.length > MAX_CODEX_SSE_LINE_BUFFER_CHARS)
	  ) {
		throw new Error(
		  'Codex SSE event exceeded the client safety limit; the response was not committed',
		)
	  }

      for (const chunk of chunks) {
		if (sawTerminalEvent) {
		  throw new Error(
			'Codex SSE emitted bytes after its terminal event; the late output was not committed',
		  )
		}
        const event = parseCodexSseEventChunk(chunk)
		if (event) {
		  yield event
		  if (isTerminalEvent(event.event)) {
			sawTerminalEvent = true
			terminalGraceDeadline ??= Date.now() + 250
		  }
		}
      }
    }
  } finally {
    if (!reachedEOF) {
      cancelReader('Codex SSE consumer completed before transport EOF')
    }
    await pendingReaderCancellation
    try {
      reader.releaseLock()
    } catch {
      // A canceled stream can settle its pending read one microtask later.
      // The body is already canceled, so never mask the original error.
    }
  }
}

function determineStopReason(
  response: Record<string, any> | undefined,
  sawToolUse: boolean,
): 'end_turn' | 'tool_use' | 'max_tokens' {
  const output = Array.isArray(response?.output) ? response.output : []
  if (
    response?.status !== 'incomplete' &&
    (sawToolUse ||
      output.some((item: { type?: string }) => item?.type === 'function_call'))
  ) {
    return 'tool_use'
  }

  const incompleteReason = response?.incomplete_details?.reason
  if (
    typeof incompleteReason === 'string' &&
    incompleteReason.includes('max_output_tokens')
  ) {
    return 'max_tokens'
  }

  return 'end_turn'
}

export async function collectCodexCompletedResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<Record<string, any>> {
  let completedResponse: Record<string, any> | undefined
  let terminalErrorMessage: string | undefined

  for await (const event of readSseEvents(response, signal)) {
	if (completedResponse || terminalErrorMessage) {
	  throw new Error(
		'Codex SSE emitted an event after its terminal event; the late output was not committed',
	  )
	}
    if (event.event === 'response.failed') {
      terminalErrorMessage = event.data?.response?.error?.message ??
        event.data?.error?.message ?? 'Codex response failed'
	  continue
    }

    if (event.event === 'response.completed') {
      completedResponse = requireCodexTerminalResponse(
        event.data,
        'completed',
      )
	  continue
    }

    if (event.event === 'response.incomplete') {
      completedResponse = requireCodexTerminalResponse(
        event.data,
        'incomplete',
      )
	  continue
    }
  }

  if (terminalErrorMessage) {
	throw APIError.generate(
	  500,
	  undefined,
	  terminalErrorMessage,
	  new Headers(),
	)
  }

  if (!completedResponse) {
    throw APIError.generate(
      500, undefined, 'Codex response ended without a completed payload',
      new Headers(),
    )
  }

  return completedResponse
}

export async function* codexStreamToAnthropic(
  response: Response,
  model: string,
  signal?: AbortSignal,
  advertisedToolNames: readonly string[] = [],
  recoverableToolNames: readonly string[] = [],
): AsyncGenerator<AnthropicStreamEvent> {
  const messageId = makeMessageId()
  const toolBlocksByItemId = new Map<
    string,
    {
      index: number
      toolUseId: string
      name: string
      startedName?: string
      argumentsBuffer: string
      emittedArgumentsLength: number
      hasStarted: boolean
      isDone: boolean
      hasStopped: boolean
    }
  >()
  let activeTextBlockIndex: number | null = null
  const emittedVisibleTextChunks: string[] = []
	let emittedVisibleTextChars = 0
	const appendVisibleText = (text: string): void => {
	  if (emittedVisibleTextChars + text.length > MAX_CODEX_VISIBLE_TEXT_CHARS) {
		throw new Error(
		  'Codex visible text exceeded the client safety limit; the response was not committed',
		)
	  }
	  emittedVisibleTextChunks.push(text)
	  emittedVisibleTextChars += text.length
	}
  const thinkFilter = createThinkTagFilter()
  let nextContentBlockIndex = 0
  let sawToolUse = false
  let finalResponse: Record<string, any> | undefined
  let terminalEvent: 'completed' | 'incomplete' | 'failed' | undefined
  let terminalErrorMessage: string | undefined
  let totalBufferedToolArgumentChars = 0
  const toolArgumentCharsLimit = maxBufferedToolArgumentChars()

  const closeActiveTextBlock = async function* () {
    if (activeTextBlockIndex === null) return
    const textBlockIndex = activeTextBlockIndex
    activeTextBlockIndex = null
    const tail = thinkFilter.flush()
    if (tail) {
	  appendVisibleText(tail)
      yield {
        type: 'content_block_delta',
        index: textBlockIndex,
        delta: {
          type: 'text_delta',
          text: tail,
        },
      }
    }
    yield {
      type: 'content_block_stop',
      index: textBlockIndex,
    }
  }

  const startTextBlockIfNeeded = async function* () {
    if (activeTextBlockIndex !== null) return
    activeTextBlockIndex = nextContentBlockIndex++
    yield {
      type: 'content_block_start',
      index: activeTextBlockIndex,
      content_block: { type: 'text', text: '' },
    }
  }

  type ActiveCodexToolBlock = NonNullable<
    ReturnType<typeof toolBlocksByItemId.get>
  >

  const replaceToolArguments = (
    toolBlock: ActiveCodexToolBlock,
    nextArguments: string,
  ): void => {
    const nextTotal =
      totalBufferedToolArgumentChars -
      toolBlock.argumentsBuffer.length +
      nextArguments.length
    if (
      nextArguments.length > toolArgumentCharsLimit ||
      nextTotal > toolArgumentCharsLimit
    ) {
      throw new Error(
        'Codex tool arguments exceeded the configured safety limit; no tool was committed',
      )
    }
    toolBlock.argumentsBuffer = nextArguments
    totalBufferedToolArgumentChars = nextTotal
  }

  const appendToolArguments = (
    toolBlock: ActiveCodexToolBlock,
    delta: string,
  ): void => {
    if (
      toolBlock.argumentsBuffer.length + delta.length >
        toolArgumentCharsLimit ||
      totalBufferedToolArgumentChars + delta.length >
        toolArgumentCharsLimit
    ) {
      throw new Error(
        'Codex tool arguments exceeded the configured safety limit; no tool was committed',
      )
    }
    toolBlock.argumentsBuffer += delta
    totalBufferedToolArgumentChars += delta.length
  }

  const findToolBlockEntry = (
    item: Record<string, any>,
  ): [string, ActiveCodexToolBlock] | undefined => {
    for (const candidate of [item.id, item.call_id]) {
      if (candidate == null) continue
      const itemId = String(candidate)
      const toolBlock = toolBlocksByItemId.get(itemId)
      if (toolBlock) return [itemId, toolBlock]
      for (const entry of toolBlocksByItemId) {
        if (entry[0] === itemId || entry[1].toolUseId === itemId) return entry
      }
    }
    return undefined
  }

  const canonicalizeFinalToolName = (toolBlock: ActiveCodexToolBlock): void => {
    const resolvedName = resolveToolNameByUniquePrefix(
      advertisedToolNames,
      toolBlock.name,
      recoverableToolNames,
    )
    if (advertisedToolNames.length > 0 && !resolvedName) {
      throw new Error(
        'Codex completed response selected an unadvertised tool; no tool was committed',
      )
    }
    if (resolvedName) toolBlock.name = resolvedName
  }

  const applyFinalToolItem = (
    toolBlock: ActiveCodexToolBlock,
    item: Record<string, any>,
  ): void => {
    if (typeof item.name === 'string' && item.name) {
      toolBlock.name = item.name
    }
    if (typeof item.arguments === 'string') {
      replaceToolArguments(toolBlock, item.arguments)
    }
    if (item.call_id != null || item.id != null) {
      toolBlock.toolUseId = String(item.call_id ?? item.id)
    }
    canonicalizeFinalToolName(toolBlock)
  }

  const emitPendingToolArguments = async function* (
    toolBlock: ActiveCodexToolBlock,
  ) {
    if (
      !toolBlock.hasStarted ||
      toolBlock.emittedArgumentsLength >= toolBlock.argumentsBuffer.length
    ) {
      return
    }

    yield {
      type: 'content_block_delta',
      index: toolBlock.index,
      delta: {
        type: 'input_json_delta',
        partial_json: toolBlock.argumentsBuffer.slice(
          toolBlock.emittedArgumentsLength,
        ),
      },
    }
    toolBlock.emittedArgumentsLength = toolBlock.argumentsBuffer.length
  }

  const startToolBlock = async function* (toolBlock: ActiveCodexToolBlock) {
    if (toolBlock.hasStarted) return

    canonicalizeFinalToolName(toolBlock)
    toolBlock.hasStarted = true
    toolBlock.startedName = toolBlock.name || 'tool'

    yield {
      type: 'content_block_start',
      index: toolBlock.index,
      content_block: {
        type: 'tool_use',
        id: toolBlock.toolUseId,
        name: toolBlock.startedName,
        input: {},
      },
    }
    yield* emitPendingToolArguments(toolBlock)
  }

  const flushToolBlocks = async function* () {
    const orderedBlocks = [...toolBlocksByItemId.values()].sort(
      (a, b) => a.index - b.index,
    )

    for (const toolBlock of orderedBlocks) {
      if (toolBlock.hasStopped) continue

      if (!toolBlock.hasStarted) {
        // Responses can update the name in output_item.done or in the final
        // response. Buffer until the call is complete so every block has one
        // immutable start event.
        if (!toolBlock.isDone) break
        yield* startToolBlock(toolBlock)
        if (!toolBlock.hasStarted) break
      }

      yield* emitPendingToolArguments(toolBlock)
      if (toolBlock.isDone) {
        toolBlock.hasStopped = true
        yield {
          type: 'content_block_stop',
          index: toolBlock.index,
        }
      }
    }
  }

  const removeStoppedToolBlocks = (): void => {
    for (const [itemId, toolBlock] of toolBlocksByItemId) {
      if (toolBlock.hasStopped) {
        totalBufferedToolArgumentChars -= toolBlock.argumentsBuffer.length
        toolBlocksByItemId.delete(itemId)
      }
    }
  }

  const closeOpenBlocksForFailure = async function* () {
    yield* closeActiveTextBlock()
    const orderedBlocks = [...new Set(toolBlocksByItemId.values())].sort(
      (a, b) => a.index - b.index,
    )
    for (const toolBlock of orderedBlocks) {
      if (!toolBlock.hasStarted || toolBlock.hasStopped) continue
      toolBlock.hasStopped = true
      yield { type: 'content_block_stop', index: toolBlock.index }
    }
    toolBlocksByItemId.clear()
  }

  yield {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: makeUsage(),
    },
  }

  try {
    for await (const event of readSseEvents(response, signal)) {
	if (terminalEvent) {
	  throw new Error(
		'Codex SSE emitted an event after its terminal event; the late output was not committed',
	  )
	}
    const payload = event.data

    if (event.event === 'response.output_item.added') {
      const item = payload.item
      if (item?.type === 'function_call') {
		if (
		  toolBlocksByItemId.size >= MAX_CODEX_ACTIVE_TOOL_CALLS ||
		  typeof item.name !== 'string' ||
		  item.name.length > MAX_CODEX_TOOL_ID_OR_NAME_CHARS ||
		  (item.id != null &&
			(typeof item.id !== 'string' ||
			  item.id.length > MAX_CODEX_TOOL_ID_OR_NAME_CHARS)) ||
		  (item.call_id != null &&
			(typeof item.call_id !== 'string' ||
			  item.call_id.length > MAX_CODEX_TOOL_ID_OR_NAME_CHARS))
		) {
		  throw new Error(
			'Codex tool identity exceeded the client safety limit; no tool was committed',
		  )
		}
        yield* closeActiveTextBlock()
        const blockIndex = nextContentBlockIndex++
        const toolUseId = item.call_id ?? item.id ?? `call_${blockIndex}`
        const toolBlock: ActiveCodexToolBlock = {
          index: blockIndex,
          toolUseId,
          name: typeof item.name === 'string' ? item.name : '',
          argumentsBuffer: '',
          emittedArgumentsLength: 0,
          hasStarted: false,
          isDone: false,
          hasStopped: false,
        }
        if (typeof item.arguments === 'string') {
          replaceToolArguments(toolBlock, item.arguments)
        }
        const itemKey = String(item.id ?? toolUseId)
        if (toolBlocksByItemId.has(itemKey)) {
          throw new Error(
            'Codex stream repeated a tool item ID; no tool was committed',
          )
        }
        toolBlocksByItemId.set(itemKey, toolBlock)
      }
      continue
    }

    if (event.event === 'response.content_part.added') {
      if (payload.part?.type === 'output_text') {
        if (toolBlocksByItemId.size > 0) {
          throw new Error(
            'Codex emitted text after a reserved tool block; the out-of-order response was not committed',
          )
        }
        yield* startTextBlockIfNeeded()
      }
      continue
    }

    if (event.event === 'response.output_text.delta') {
      if (toolBlocksByItemId.size > 0) {
        throw new Error(
          'Codex emitted text after a reserved tool block; the out-of-order response was not committed',
        )
      }
      yield* startTextBlockIfNeeded()
      if (activeTextBlockIndex !== null) {
		const rawDelta = payload.delta ?? ''
		if (typeof rawDelta !== 'string' || hasInvalidUnicodeScalar(rawDelta)) {
		  throw new Error(
			'Codex emitted text with an invalid Unicode scalar; the corrupted text was not rendered',
		  )
		}
		const visible = thinkFilter.feed(rawDelta)
        if (visible) {
		  appendVisibleText(visible)
          yield {
            type: 'content_block_delta',
            index: activeTextBlockIndex,
            delta: {
              type: 'text_delta',
              text: visible,
            },
          }
        }
      }
      continue
    }

    if (event.event === 'response.function_call_arguments.delta') {
      const toolBlock = toolBlocksByItemId.get(String(payload.item_id ?? ''))
      if (toolBlock) {
        if (typeof payload.delta === 'string') {
          appendToolArguments(toolBlock, payload.delta)
        }
      }
      continue
    }

    if (event.event === 'response.output_item.done') {
      const item = payload.item
      if (item?.type === 'function_call') {
        const toolBlockEntry = findToolBlockEntry(item)
        if (toolBlockEntry) {
          const [, toolBlock] = toolBlockEntry
          applyFinalToolItem(toolBlock, item)
          toolBlock.isDone = true
        }
      } else if (item?.type === 'message') {
        yield* closeActiveTextBlock()
      }
      continue
    }

    if (event.event === 'response.completed') {
      terminalEvent = 'completed'
      finalResponse = requireCodexTerminalResponse(payload, 'completed')
	  continue
    }

    if (event.event === 'response.incomplete') {
      terminalEvent = 'incomplete'
      finalResponse = requireCodexTerminalResponse(payload, 'incomplete')
	  continue
    }

    if (event.event === 'response.failed') {
      terminalEvent = 'failed'
      terminalErrorMessage = payload?.response?.error?.message ??
        payload?.error?.message ?? 'Codex response failed'
	  continue
    }
  }

  yield* closeActiveTextBlock()

  if (terminalEvent === 'failed') {
    toolBlocksByItemId.clear()
    throw APIError.generate(
      500,
      undefined,
      terminalErrorMessage ?? 'Codex response failed',
      new Headers(),
    )
  }
  if (!terminalEvent || !finalResponse) {
    toolBlocksByItemId.clear()
    throw APIError.generate(
      500,
      undefined,
      'Codex response ended without a terminal payload',
      new Headers(),
    )
  }

  const finalVisibleText = completedCodexVisibleText(finalResponse)
	if (hasInvalidUnicodeScalar(finalVisibleText)) {
	  throw APIError.generate(
		500,
		undefined,
		'Codex completed text contained an invalid Unicode scalar; the corrupted text was not rendered',
		new Headers(),
	  )
	}
	const emittedVisibleText = emittedVisibleTextChunks.join('')
	let missingSuffix = ''
  if (!emittedVisibleText) {
    missingSuffix = finalVisibleText
  } else if (finalVisibleText.startsWith(emittedVisibleText)) {
    missingSuffix = finalVisibleText.slice(emittedVisibleText.length)
  } else if (finalVisibleText !== emittedVisibleText) {
    throw APIError.generate(
      500,
      undefined,
      'Codex completed text contradicted streamed text; response was not committed',
      new Headers(),
    )
  }
  if (missingSuffix && toolBlocksByItemId.size > 0) {
    toolBlocksByItemId.clear()
    throw APIError.generate(
      500,
      undefined,
      'Codex completed text arrived after a reserved tool block; the out-of-order response was not committed',
      new Headers(),
    )
  }
  if (missingSuffix) {
    yield* startTextBlockIfNeeded()
    if (activeTextBlockIndex !== null) {
	  appendVisibleText(missingSuffix)
      yield {
        type: 'content_block_delta',
        index: activeTextBlockIndex,
        delta: { type: 'text_delta', text: missingSuffix },
      }
    }
    yield* closeActiveTextBlock()
  }

  if (terminalEvent === 'incomplete') {
    toolBlocksByItemId.clear()
    yield {
      type: 'message_delta',
      delta: {
        stop_reason: determineStopReason(finalResponse, false),
        stop_sequence: null,
      },
      usage: makeUsage(
        finalResponse.usage as Record<string, unknown> | undefined,
      ),
    }
    yield { type: 'message_stop' }
    return
  }

  const finalOutput = Array.isArray(finalResponse?.output)
    ? finalResponse.output
    : []
  const reservedToolIndices = [...toolBlocksByItemId.values()].map(
    toolBlock => toolBlock.index,
  )
  const firstFinalToolIndex = reservedToolIndices.length > 0
    ? Math.min(...reservedToolIndices)
    : nextContentBlockIndex
  const completedToolBlocks = new Set<ActiveCodexToolBlock>()
  const completedToolCallIds = new Set<string>()
	for (const item of finalOutput) {
	  if (item?.type !== 'function_call') continue
	  if (completedToolBlocks.size >= MAX_CODEX_ACTIVE_TOOL_CALLS) {
		toolBlocksByItemId.clear()
		throw APIError.generate(
		  500,
		  undefined,
		  'Codex completed response contained too many tool calls; no tool was committed',
		  new Headers(),
		)
	  }
    try {
      parseCompletedCodexTool(item)
    } catch (error) {
      toolBlocksByItemId.clear()
      throw APIError.generate(
        500,
        undefined,
        error instanceof Error ? error.message : 'Invalid Codex tool call',
        new Headers(),
      )
    }
	  let toolBlockEntry = findToolBlockEntry(item)
	  if (!toolBlockEntry) {
		if (toolBlocksByItemId.size >= MAX_CODEX_ACTIVE_TOOL_CALLS) {
		  toolBlocksByItemId.clear()
		  throw APIError.generate(
			500,
			undefined,
			'Codex completed response exceeded the tool state limit; no tool was committed',
			new Headers(),
		  )
		}
		const blockIndex = nextContentBlockIndex++
      const { toolUseId } = parseCompletedCodexTool(item)
      const toolBlock: ActiveCodexToolBlock = {
        index: blockIndex,
        toolUseId,
        name: '',
        argumentsBuffer: '',
        emittedArgumentsLength: 0,
        hasStarted: false,
        isDone: false,
        hasStopped: false,
      }
      const itemKey = String(item.id ?? item.call_id ?? toolUseId)
      toolBlocksByItemId.set(itemKey, toolBlock)
      toolBlockEntry = [itemKey, toolBlock]
    }
    if (completedToolBlocks.has(toolBlockEntry[1])) {
      toolBlocksByItemId.clear()
      throw APIError.generate(
        500,
        undefined,
        'Codex completed response repeated a tool call; no tool was committed',
        new Headers(),
      )
    }
    applyFinalToolItem(toolBlockEntry[1], item)
    if (completedToolCallIds.has(toolBlockEntry[1].toolUseId)) {
      toolBlocksByItemId.clear()
      throw APIError.generate(
        500,
        undefined,
        'Codex completed response reused a tool call ID; no tool was committed',
        new Headers(),
      )
    }
    completedToolCallIds.add(toolBlockEntry[1].toolUseId)
    toolBlockEntry[1].isDone = true
    completedToolBlocks.add(toolBlockEntry[1])
  }
  let authoritativeToolOffset = 0
  for (const toolBlock of completedToolBlocks) {
    toolBlock.index = firstFinalToolIndex + authoritativeToolOffset++
  }
  if (completedToolBlocks.size > 0) {
    nextContentBlockIndex = firstFinalToolIndex + completedToolBlocks.size
  }
  for (const [itemId, toolBlock] of toolBlocksByItemId) {
    if (!completedToolBlocks.has(toolBlock)) {
      totalBufferedToolArgumentChars -= toolBlock.argumentsBuffer.length
      toolBlocksByItemId.delete(itemId)
    }
  }
  sawToolUse = completedToolBlocks.size > 0
  yield* flushToolBlocks()
  removeStoppedToolBlocks()

  yield {
    type: 'message_delta',
    delta: {
      stop_reason: determineStopReason(finalResponse, sawToolUse),
      stop_sequence: null,
    },
    // Delegate to the shared normalizer so the streaming message_delta
    // path uses the same raw→Anthropic conversion as makeUsage() above
    // and the non-streaming response converter below. Previously this
    // block had its own inline subtraction that missed Kimi / DeepSeek
    // / Gemini raw shapes that the shared helper handles.
    usage: makeUsage(
      finalResponse?.usage as Record<string, unknown> | undefined,
    ),
  }
    yield { type: 'message_stop' }
  } catch (error) {
    // A rejected network read or any malformed terminal payload must not leave
    // Ink with an unterminated text/tool block.
    yield* closeOpenBlocksForFailure()
    throw error
  }
}

export function convertCodexResponseToAnthropicMessage(
  data: Record<string, any>,
  model: string,
  advertisedToolNames: readonly string[] = [],
  recoverableToolNames: readonly string[] = [],
): Record<string, unknown> {
	if (hasInvalidUnicodeScalarDeep(data)) {
	  throw new Error(
		'Codex completed response contained an invalid Unicode scalar; the corrupted response was not committed',
	  )
	}
  const content: Array<Record<string, unknown>> = []
  const output = Array.isArray(data.output) ? data.output : []
  if (data.status == null) {
    throw new Error(
      'Codex response omitted its terminal status; the response was not committed',
    )
  }
  if (data.status === 'failed') {
    const failureMessage =
      typeof data.error?.message === 'string'
        ? `: ${data.error.message}`
        : ''
    throw new Error(`Codex response failed${failureMessage}`)
  }
  if (data.status !== 'completed' && data.status !== 'incomplete') {
    throw new Error(
      `Codex response carried non-terminal status "${String(data.status)}"; the response was not committed`,
    )
  }
  const mayCommitTools = data.status === 'completed'
  const completedToolCallIds = new Set<string>()
  let completedToolArgumentChars = 0
  const toolArgumentCharsLimit = maxBufferedToolArgumentChars()

  for (const item of output) {
    if (item?.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === 'output_text') {
          content.push({
            type: 'text',
            text: stripThinkTags(part.text ?? ''),
          })
        }
      }
      continue
    }

    if (item?.type === 'function_call' && mayCommitTools) {
      const { input, toolUseId } = parseCompletedCodexTool(item)
      completedToolArgumentChars += item.arguments.length
      if (completedToolArgumentChars > toolArgumentCharsLimit) {
        throw new Error(
          'Codex tool arguments exceeded the configured safety limit; no tool was committed',
        )
      }
      if (completedToolCallIds.has(toolUseId)) {
        throw new Error(
          'Codex completed response reused a tool call ID; no tool was committed',
        )
      }
      completedToolCallIds.add(toolUseId)
      const toolName =
        resolveToolNameByUniquePrefix(
          advertisedToolNames,
          item.name ?? '',
          recoverableToolNames,
        ) ??
        item.name ??
        'tool'
      if (
        advertisedToolNames.length > 0 &&
        !resolveToolNameByUniquePrefix(
          advertisedToolNames,
          item.name ?? '',
          recoverableToolNames,
        )
      ) {
        throw new Error(
          'Codex completed response selected an unadvertised tool; no tool was committed',
        )
      }
      content.push({
        type: 'tool_use',
        id: toolUseId,
        name: toolName,
        input,
      })
    }
  }

  return {
    id: data.id ?? makeMessageId(),
    type: 'message',
    role: 'assistant',
    content,
    model: data.model ?? model,
    stop_reason: determineStopReason(data, content.some(item => item.type === 'tool_use')),
    stop_sequence: null,
    usage: makeUsage(data.usage),
  }
}
