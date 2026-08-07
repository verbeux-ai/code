/**
 * routerClient.js — HTTP client for the Verboo Router chat/completions endpoint.
 *
 * POST https://code.verboo.ai/router/v1/chat/completions
 * OpenAI-compatible: { messages, model, tools, tool_choice: 'auto' }.
 * Response parsed as OpenAI-style: { choices: [{ message }] }.
 *
 * Pure — no chrome.*. Only fetch() + AbortSignal. 60s timeout default.
 */

const CHAT_URL = 'https://code.verboo.ai/router/v1/chat/completions'
const DEFAULT_TIMEOUT_MS = 60_000

// The eight real browser tools the controller knows how to execute.
// Anything else the model emits (e.g. `computer.wait`, `garbage_tool`)
// is a hallucination and must be dropped at parse time — passing it
// through would surface a fake tool name to the user or the controller.
const BROWSER_TOOL_NAMES = new Set([
  'click',
  'navigate',
  'read_page',
  'find',
  'extract_page_content',
  'structured_extract',
  'screenshot',
  'tab_group',
  'tabs',
  'type',
])

/**
 * Send a chat completion request to the Verboo Router.
 *
 * @param {{ accessToken: string, model: string, messages: Array<object>, tools?: Array<object>, signal?: AbortSignal, timeoutMs?: number, refreshAccessToken?: () => Promise<string|null> }} params
 * @returns {Promise<{ content: string|null, toolCalls: Array<{id:string,name:string,arguments:string}> }>}
 */
export async function chatCompletion({
  accessToken,
  model,
  messages,
  tools,
  signal: externalSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  refreshAccessToken,
}) {
  if (!accessToken) throw new Error('chatCompletion: accessToken is required')
  if (!model) throw new Error('chatCompletion: model is required')
  if (!Array.isArray(messages)) throw new Error('chatCompletion: messages is required')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  if (externalSignal?.aborted) { clearTimeout(timer); controller.abort() }
  const onExternalAbort = () => controller.abort()
  if (externalSignal?.addEventListener) {
    externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }

  try {
    let token = accessToken
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model,
          messages,
          tools: tools && tools.length > 0 ? tools : undefined,
          tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
        }),
        signal: controller.signal,
      })

      if (res.status === 401 && attempt === 0 && typeof refreshAccessToken === 'function') {
        const refreshed = await refreshAccessToken()
        if (typeof refreshed === 'string' && refreshed) {
          token = refreshed
          continue
        }
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`Router returned HTTP ${res.status}: ${body.slice(0, 200)}`)
      }

      const json = await readCompletionPayload(res)
      return parseCompletionResponse(json)
    }
    throw new Error('Router authorization retry exhausted')
  } catch (err) {
    // Surface timeouts/cancels as plain Errors so the agent loop / fallback
    // can recover instead of leaving the panel stuck on "Working…".
    if (controller.signal.aborted) {
      if (externalSignal?.aborted) {
        throw new Error('Router request cancelled')
      }
      throw new Error(`Router timed out after ${timeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timer)
    if (externalSignal?.removeEventListener) {
      externalSignal.removeEventListener('abort', onExternalAbort)
    }
  }
}

/**
 * Parse an OpenAI-style chat completion response.
 *
 * Side effect: any tool-call markup found inside the assistant content
 * is ALWAYS stripped — whether or not structured calls were extracted.
 * This is intentional: the raw markup was a user-facing bug
 * (model-printed tool call leaked to conversation). Whether to execute
 * the parsed calls is the agent loop's responsibility
 * (browserToolsEnabled gate), not the parser's.
 *
 * @param {unknown} json
 * @returns {{ content: string|null, toolCalls: Array<{id:string,name:string,arguments:string}> }}
 */
export function parseCompletionResponse(json) {
  if (!json || typeof json !== 'object') throw new Error('Router returned an unreadable response')
  const obj = /** @type {Record<string, unknown>} */ (json)
  let choices = Array.isArray(obj.choices) ? obj.choices : null
  if (!choices?.length && obj.message && typeof obj.message === 'object') {
    choices = [{ message: obj.message }]
  }
  if (!choices?.length) throw new Error('No choices in response')

  const message = /** @type {Record<string, unknown>|undefined} */ (choices[0].message)
  if (!message) throw new Error('No message in first choice')

  let content = typeof message.content === 'string' ? message.content : null
  const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  const toolCalls = []
  for (const tc of rawToolCalls) {
    if (!tc || typeof tc !== 'object') continue
    const fn = /** @type {Record<string, unknown>|undefined} */ (tc.function)
    if (!fn || typeof fn !== 'object') continue
    const id = typeof tc.id === 'string' ? tc.id : `tc_${Math.random().toString(36).slice(2, 10)}`
    const name = typeof fn.name === 'string' ? fn.name : null
    const args = typeof fn.arguments === 'string' ? fn.arguments : '{}'
    if (name) toolCalls.push({ id, name, arguments: args })
  }

  if (Array.isArray(message.content)) {
    const textParts = []
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue
      if (part.type === 'text' && typeof part.text === 'string') textParts.push(part.text)
      if (part.type === 'tool_use' && typeof part.name === 'string') {
        toolCalls.push({
          id: typeof part.id === 'string' ? part.id : fallbackToolCallId(),
          name: part.name,
          arguments: JSON.stringify(part.input && typeof part.input === 'object' ? part.input : {}),
        })
      }
    }
    content = textParts.join('\n').trim() || null
  }

  // ──────────────────────────────────────────────────────────────────
  // PRESENTATION (non-negotiable) + EXECUTION (separate decision).
  //
  // PRESENTATION: strip ALL <tool_call>...</tool_call> markup from
  // `content` regardless of what else is in the response. The user
  // must NEVER see raw tool-call markup leaking to the conversation
  // (the original A2-CHROME user report). Prose outside the tags is
  // preserved. Two passes cover the malformed inputs the tests lock
  // in:
  //   1. well-formed <tool_call>...</tool_call> blocks (and the
  //      namespaced <minimax:tool_call>...</minimax:tool_call> form)
  //   2. an orphan <tool_call> opener with no matching closer
  //      (model emitted partial/malformed markup) — drop just the
  //      bare opener tag, keep the trailing prose so we don't lose
  //      user-visible content the model emitted after the malformed
  //      opener
  //
  // EXECUTION: only forward parsed text calls when there are no
  // structured tool_calls already captured above. If the model emits
  // a structured `type` call AND mirrors it as text markup, pushing
  // both would double-execute (loop.js's dedupeToolCalls keys on
  // name + canonical arguments, and the text form's arguments differ
  // from the structured form's — so dedupe does NOT save us). Strip
  // the markup either way; only forward the parsed calls when there
  // are no structured ones.
  //
  // NO THROW on malformed markup: the OLD parser threw "Router
  // returned a malformed text tool call" when parsing failed, which
  // left the panel stuck on "Working…" because nothing got returned.
  // The NEW behavior: silently drop unrecognized markup, return the
  // remaining prose, let the loop decide how to communicate.
  if (content && /<(?::?minimax:)?tool_call>/i.test(content)) {
    const parsed = parseXmlToolCalls(content)
    if (toolCalls.length === 0) toolCalls.push(...parsed)
    content = content
      .replace(/<(?::?minimax:)?tool_call>[\s\S]*?<\/(?:minimax:)?tool_call>/gi, '')
      .replace(/<(?::?minimax:)?tool_call>/gi, '')
      .trim() || null
  }
  return { content, toolCalls }
}

// Extract structured tool calls from text markup. Recognizes TWO
// shapes the model emits inside a <tool_call>...</tool_call>
// envelope:
//   1. <invoke name="...">...</invoke> (Anthropic-style)
//   2. <function=NAME>...</function> (the user's report shape,
//      including function=computer with parameter=action=...)
// Names are normalized (browser_ prefix stripped, family.dotted
// resolved to inner tool) and validated against the 7-name whitelist.
// Invalid names are dropped, not passed through.
function parseXmlToolCalls(content) {
  const calls = []
  for (const match of content.matchAll(
    /<(?::?minimax:)?tool_call>([\s\S]*?)<\/(?:minimax:)?tool_call>/gi,
  )) {
    const body = match[1]
    const jsonCalls = parseJsonToolCalls(body)
    if (jsonCalls.length > 0) {
      calls.push(...jsonCalls)
      continue
    }
    const invokes = [...body.matchAll(
      /<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/invoke>/gi,
    )]
    if (invokes.length > 0) {
      for (const invoke of invokes) {
        const params = parseNamedParameters(invoke[2])
        const name = normalizeTextToolName(decodeXml(invoke[1].trim()))
        if (name && isValidToolName(name)) {
          calls.push({
            id: fallbackToolCallId(),
            name,
            arguments: JSON.stringify(params),
          })
        }
      }
      continue
    }

    const rawFunction =
      body.match(/<function=([^>]+)>/i)?.[1] ??
      body.match(/<function>([^<]+)<\/function>/i)?.[1]
    if (!rawFunction) continue
    const params = {}
    for (const parameter of body.matchAll(/<parameter=([^>]+)>([\s\S]*?)<\/parameter>/gi)) {
      params[decodeXml(parameter[1].trim())] = decodeXml(parameter[2].trim())
    }
    Object.assign(params, parseNamedParameters(body))
    const functionName = decodeXml(rawFunction.trim())
    // Family wrappers (browser, computer) with an action param unwrap
    // to the inner tool name. Bare family names with no action fall
    // through to normalizeTextToolName so dotted forms like
    // `computer.navigate` also resolve.
    const name = (functionName === 'browser' || functionName === 'computer')
      && typeof params.action === 'string'
      ? params.action
      : normalizeTextToolName(functionName)
    if (functionName === 'browser' || functionName === 'computer') delete params.action
    if (name && isValidToolName(name)) {
      calls.push({ id: fallbackToolCallId(), name, arguments: JSON.stringify(params) })
    }
  }
  return calls
}

/**
 * Parse the JSON envelope emitted by some OpenAI-compatible models:
 * `{ "name": "computer.navigate", "arguments": { ... } }`.
 * It commonly arrives inside the same `<tool_call>` wrapper as the XML
 * dialects above. Arguments may be either an object or a JSON string.
 * Unknown tools are dropped by the same whitelist as XML calls.
 */
function parseJsonToolCalls(body) {
  const trimmed = String(body ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  if (!trimmed) return []

  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // Be tolerant of a short bit of prose around the JSON object while
    // avoiding a broad scan that could mistake page content for a call.
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start < 0 || end <= start) return []
    try {
      parsed = JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      return []
    }
  }

  const entries = Array.isArray(parsed) ? parsed : [parsed]
  const calls = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = /** @type {Record<string, unknown>} */ (entry)
    const fn = record.function && typeof record.function === 'object'
      ? /** @type {Record<string, unknown>} */ (record.function)
      : null
    const rawName = record.name ?? record.tool ?? fn?.name
    if (typeof rawName !== 'string' || !rawName.trim()) continue

    let rawArguments = record.arguments ?? record.input ?? record.parameters ?? fn?.arguments ?? {}
    if (typeof rawArguments === 'string') {
      try {
        rawArguments = JSON.parse(rawArguments)
      } catch {
        rawArguments = {}
      }
    }
    const params = rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)
      ? { .../** @type {Record<string, unknown>} */ (rawArguments) }
      : {}
    const functionName = rawName.trim()
    const name = (functionName === 'browser' || functionName === 'computer')
      && typeof params.action === 'string'
      ? params.action
      : normalizeTextToolName(functionName)
    if (functionName === 'browser' || functionName === 'computer') delete params.action
    if (name && isValidToolName(name)) {
      calls.push({
        id: fallbackToolCallId(),
        name,
        arguments: JSON.stringify(params),
      })
    }
  }
  return calls
}

function parseNamedParameters(body) {
  const params = {}
  for (const parameter of body.matchAll(
    /<parameter\s+name=["']([^"']+)["']>([\s\S]*?)<\/parameter>/gi,
  )) {
    params[decodeXml(parameter[1].trim())] = decodeXml(parameter[2].trim())
  }
  return params
}

function normalizeTextToolName(name) {
  const value = String(name).trim()
  if (value.startsWith('browser_')) {
    const unprefixed = value.slice('browser_'.length)
    if (isValidToolName(unprefixed)) return unprefixed
  }
  // Dotted family forms (e.g. `browser.navigate`, `computer.click`,
  // `computer.wait`) — emitted by some models when they don't know the
  // exact tool name. Take the suffix after the last dot; only return
  // it if it matches a real tool. Otherwise the name is invalid and
  // isValidToolName() will drop it at the call site.
  const lastDot = value.lastIndexOf('.')
  if (lastDot > 0 && lastDot < value.length - 1) {
    const family = value.slice(0, lastDot)
    const suffix = value.slice(lastDot + 1)
    if ((family === 'browser' || family === 'computer') && isValidToolName(suffix)) {
      return suffix
    }
  }
  return value
}

// Whether a normalized name is a real browser tool. Used by
// parseXmlToolCalls to drop hallucinated tool names at parse time
// instead of forwarding them to the controller.
function isValidToolName(name) {
  return BROWSER_TOOL_NAMES.has(name)
}

async function readCompletionPayload(response) {
  if (typeof response.text !== 'function') {
    return response.json()
  }

  const body = await response.text()
  const contentType = response.headers?.get?.('content-type') ?? ''
  if (contentType.includes('text/event-stream') || /^\s*data:/m.test(body)) {
    return parseSseCompletion(body)
  }

  try {
    return JSON.parse(body)
  } catch {
    throw new Error('Router returned invalid JSON')
  }
}

function parseSseCompletion(body) {
  const events = []
  let buffer = ''
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      buffer += line.slice(5).trimStart()
      continue
    }
    if (line === '' && buffer) {
      events.push(buffer)
      buffer = ''
    }
  }
  if (buffer) events.push(buffer)

  let merged = null
  for (const event of events) {
    if (event === '[DONE]') break
    let payload
    try {
      payload = JSON.parse(event)
    } catch {
      continue
    }
    merged = mergeStreamedChoice(merged, payload)
  }
  if (!merged) throw new Error('Router stream had no parseable events')
  return merged
}

function mergeStreamedChoice(acc, payload) {
  if (!payload || typeof payload !== 'object') return acc
  const choices = Array.isArray(payload.choices) ? payload.choices : null
  if (!choices?.length) return acc
  const choice = choices[0]
  const delta = choice?.delta ?? choice?.message
  if (!acc) {
    return {
      choices: [{
        ...choice,
        message: {
          ...(delta ?? {}),
          tool_calls: Array.isArray(delta?.tool_calls) ? delta.tool_calls : undefined,
        },
      }],
    }
  }
  const accMessage = acc.choices[0].message ?? {}
  const accContent = typeof accMessage.content === 'string' ? accMessage.content : ''
  const deltaContent = typeof delta?.content === 'string' ? delta.content : ''
  const accToolCalls = Array.isArray(accMessage.tool_calls) ? accMessage.tool_calls : []
  const deltaToolCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : []
  const toolCalls = mergeToolCalls(accToolCalls, deltaToolCalls)
  acc.choices[0] = {
    ...choice,
    message: {
      ...accMessage,
      ...delta,
      content: accContent + deltaContent,
      tool_calls: toolCalls.length > 0 ? toolCalls : accMessage.tool_calls,
    },
  }
  return acc
}

function mergeToolCalls(acc, delta) {
  const out = [...acc]
  for (const tc of delta) {
    const index = typeof tc.index === 'number' ? tc.index : 0
    if (!out[index]) {
      out[index] = {
        id: typeof tc.id === 'string' ? tc.id : fallbackToolCallId(),
        type: tc.type ?? 'function',
        function: { name: '', arguments: '' },
      }
    }
    if (typeof tc.id === 'string') out[index].id = tc.id
    if (tc.function) {
      if (typeof tc.function.name === 'string') out[index].function.name += tc.function.name
      if (typeof tc.function.arguments === 'string') out[index].function.arguments += tc.function.arguments
    }
  }
  return out
}

function fallbackToolCallId() {
  return `tc_${Math.random().toString(36).slice(2, 10)}`
}

function decodeXml(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

export const __test__ = {
  parseCompletionResponse,
  parseXmlToolCalls,
  parseJsonToolCalls,
  normalizeTextToolName,
  isValidToolName,
  mergeToolCalls,
  parseSseCompletion,
}
