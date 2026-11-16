// Small HTTP helpers shared by the human-session fakes and by routerHandler /
// codexHandler hooks written in scenarios.
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'

export async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return { raw, body: undefined }
  try { return { raw, body: JSON.parse(raw) } } catch { return { raw, body: raw } }
}

export function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(value))
}

const SECRET_HEADERS = new Set(['authorization', 'x-api-key', 'api-key', 'cookie', 'proxy-authorization'])

/** Copy of headers safe to write into artifact files (secrets reduced to their last 4 chars). */
export function redactHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name,
    SECRET_HEADERS.has(name.toLowerCase()) && typeof value === 'string' ? `<redacted …${value.slice(-4)}>` : value,
  ]))
}

export function redactRecords(records) {
  return records.map(record => ({ ...record, headers: record.headers ? redactHeaders(record.headers) : record.headers }))
}

/**
 * Starts a loopback server whose handler receives (req, res, record).
 * Tracks in-flight handlers so close() drains them, and records handler
 * failures into `unexpected` instead of crashing the test process.
 */
export async function startLoopbackServer(handler, { unexpected = [] } = {}) {
  const active = new Set()
  const server = createServer((req, res) => {
    const handling = handler(req, res).catch(error => {
      if (req.aborted || error?.code === 'ECONNRESET' || res.destroyed) return
      unexpected.push(`Fixture handler failed: ${error?.stack ?? error}`)
      res.destroy()
    }).finally(() => active.delete(handling))
    active.add(handling)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    unexpected,
    async close() {
      const closed = new Promise(resolve => server.close(resolve))
      server.closeAllConnections()
      await closed
      await Promise.all([...active])
    },
  }
}

// ---- OpenAI-compatible chat completions (Verboo router, OpenAI API) ----

/**
 * Writes an OpenAI chat completion, streaming (SSE chunks + [DONE]) when
 * request.stream is true, otherwise one chat.completion JSON object.
 *
 * spec: { text?, reasoning?, toolCalls?: [{ id?, name, arguments (object|string) }],
 *         finishReason?, usage?, model?, id?, headers?, chunkSize?, delayMs? }
 * finishReason defaults to 'tool_calls' when toolCalls are present, else 'stop'.
 */
export async function sendChatCompletion(res, request = {}, spec = {}) {
  const model = spec.model ?? request.model ?? 'fixture-model'
  const id = spec.id ?? `chatcmpl-fixture-${Math.random().toString(36).slice(2, 10)}`
  const toolCalls = (spec.toolCalls ?? []).map((call, index) => ({
    index,
    id: call.id ?? `call_fixture_${index}`,
    type: 'function',
    function: { name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}) },
  }))
  const finishReason = spec.finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop')
  const usage = spec.usage === null ? undefined : spec.usage ?? { prompt_tokens: 120, completion_tokens: 24, total_tokens: 144 }
  const text = spec.text ?? (toolCalls.length ? '' : 'FIXTURE_REPLY')
  if (request.stream !== true) {
    return sendJson(res, 200, {
      id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(spec.reasoning && { reasoning_content: spec.reasoning }), ...(toolCalls.length && { tool_calls: toolCalls.map(({ index, ...call }) => call) }) }, finish_reason: finishReason }],
      ...(usage && { usage }),
    }, spec.headers)
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...spec.headers })
  const created = Math.floor(Date.now() / 1000)
  const emit = (delta, finish_reason = null, extra = {}) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`)
  emit({ role: 'assistant' })
  if (spec.reasoning) emit({ reasoning_content: spec.reasoning })
  const chunkSize = spec.chunkSize ?? 16
  for (let index = 0; index < text.length; index += chunkSize) {
    if (res.destroyed) return
    emit({ content: text.slice(index, index + chunkSize) })
    if (spec.delayMs) await delay(spec.delayMs)
  }
  for (const call of toolCalls) {
    const args = call.function.arguments
    emit({ tool_calls: [{ index: call.index, id: call.id, type: 'function', function: { name: call.function.name, arguments: args.slice(0, 10) } }] })
    if (args.length > 10) emit({ tool_calls: [{ index: call.index, function: { arguments: args.slice(10) } }] })
  }
  emit({}, finishReason, usage ? { usage } : {})
  res.end('data: [DONE]\n\n')
}

/** Text of the last user message in an OpenAI chat request (string or parts). */
export function lastUserText(request) {
  const message = [...(request?.messages ?? [])].reverse().find(item => item.role === 'user')
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  return (message.content ?? []).map(part => part.text ?? '').join('\n')
}

/** Whether an OpenAI-shaped request is the auto mode classifier's (it carries the classify_result tool). */
export function isClassifierRequest(request) {
  return (request?.tools ?? []).some(tool => (tool.function?.name ?? tool.name) === 'classify_result')
}

/**
 * Answers a classifier request with a verdict. finish_reason defaults to "stop":
 * the real router ends a forced tool call that way (see the #81 shim fix).
 */
export function sendClassifierVerdict(res, request, { shouldBlock = false, reason = 'Fixture verdict', thinking = 'Fixture reasoning', ...spec } = {}) {
  return sendChatCompletion(res, request, { finishReason: 'stop', ...spec, toolCalls: [{ name: 'classify_result', arguments: { thinking, shouldBlock, reason } }] })
}

/** Whether the chat request already carries a tool result (role "tool"). */
export function hasToolResult(request) {
  return (request?.messages ?? []).some(message => message.role === 'tool')
}

/** The background agent that runs after a turn: it also carries tools, but it is not a turn. */
export const isMemoryExtraction = body => JSON.stringify(body?.messages ?? body?.input ?? '').includes('memory extraction subagent')
