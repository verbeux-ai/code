// Fake Anthropic API (api.anthropic.com) for PTY fixtures. startCli({ anthropic })
// starts it and sets CLI_E2E_ANTHROPIC_ORIGIN so the preload redirects
// api.anthropic.com here.
import { setTimeout as delay } from 'node:timers/promises'
import { readBody, sendJson, startLoopbackServer } from './http.mjs'

export const DEFAULT_ANTHROPIC_MODELS = [
  {
    type: 'model', id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5', created_at: '2025-09-29T00:00:00Z',
    max_input_tokens: 200000, max_tokens: 64000,
    capabilities: { image_input: { supported: true }, effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true } } },
  },
  {
    type: 'model', id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z',
    max_input_tokens: 200000, max_tokens: 64000,
    capabilities: { image_input: { supported: true } },
  },
]

function errorEnvelope(status, type, message, headers = {}) {
  return { status, json: { type: 'error', error: { type, message } }, headers }
}

/**
 * Real error envelopes, usable as responder/enqueue specs. creditBalanceTooLow
 * leaves the provider name out of its message because scripts/rebrand-check.ts
 * rejects it in a literal; the CLI only matches "credit balance is too low".
 */
export const anthropicErrors = {
  unauthorized: () => errorEnvelope(401, 'authentication_error', 'invalid x-api-key'),
  permissionDenied: () => errorEnvelope(403, 'permission_error', 'Your API key does not have permission to use the specified resource.'),
  creditBalanceTooLow: () => errorEnvelope(400, 'invalid_request_error', 'Your credit balance is too low to access the API. Please go to Plans & Billing to upgrade or purchase credits.'),
  rateLimited: (retryAfterSeconds = 1) => errorEnvelope(429, 'rate_limit_error', 'This request would exceed the rate limit for your organization of 50 requests per minute. Please try again later.', { 'retry-after': String(retryAfterSeconds) }),
  overloaded: () => errorEnvelope(529, 'overloaded_error', 'Overloaded'),
  invalidRequest: (message = 'Invalid request') => errorEnvelope(400, 'invalid_request_error', message),
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
}

function normalizeContent(spec) {
  if (Array.isArray(spec.content)) return spec.content
  return [{ type: 'text', text: spec.text ?? 'ANTHROPIC_FIXTURE_REPLY' }]
}

/**
 * Writes an Anthropic Messages response: SSE in the real event order when
 * request.stream is true, otherwise one JSON message.
 * spec: { text? | content?: [{type:'text',text} | {type:'tool_use',name,input,id?} | {type:'thinking',thinking}],
 *         stopReason?, usage?: {input_tokens, output_tokens}, model?, id?, delayMs?, chunkSize?, headers? }
 */
export async function sendAnthropicMessage(res, request = {}, spec = {}) {
  const content = normalizeContent(spec).map((block, index) => block.type === 'tool_use' ? { id: block.id ?? `toolu_fixture_${index}`, input: {}, ...block } : block)
  const model = spec.model ?? request.model ?? DEFAULT_ANTHROPIC_MODELS[0].id
  const id = spec.id ?? `msg_fixture_${Math.random().toString(36).slice(2, 12)}`
  const stopReason = spec.stopReason ?? (content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn')
  const usage = { input_tokens: 120, output_tokens: 24, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...spec.usage }
  const headers = { 'request-id': `req_fixture_${id}`, ...spec.headers }
  if (request.stream !== true) {
    const finalContent = content.map(block => block.type === 'thinking' ? { signature: 'fixture-signature', ...block } : block)
    return sendJson(res, 200, { id, type: 'message', role: 'assistant', model, content: finalContent, stop_reason: stopReason, stop_sequence: null, usage }, headers)
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...headers })
  const chunkSize = spec.chunkSize ?? 16
  const pause = async () => { if (spec.delayMs) await delay(spec.delayMs) }
  sse(res, 'message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } })
  sse(res, 'ping', {})
  for (const [index, block] of content.entries()) {
    if (res.destroyed) return
    if (block.type === 'text') {
      sse(res, 'content_block_start', { index, content_block: { type: 'text', text: '' } })
      for (let offset = 0; offset < block.text.length; offset += chunkSize) {
        if (res.destroyed) return
        sse(res, 'content_block_delta', { index, delta: { type: 'text_delta', text: block.text.slice(offset, offset + chunkSize) } })
        await pause()
      }
    } else if (block.type === 'tool_use') {
      sse(res, 'content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })
      const json = JSON.stringify(block.input ?? {})
      for (let offset = 0; offset < json.length; offset += chunkSize) {
        sse(res, 'content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: json.slice(offset, offset + chunkSize) } })
        await pause()
      }
    } else if (block.type === 'thinking') {
      sse(res, 'content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } })
      sse(res, 'content_block_delta', { index, delta: { type: 'thinking_delta', thinking: block.thinking ?? '' } })
      sse(res, 'content_block_delta', { index, delta: { type: 'signature_delta', signature: block.signature ?? 'fixture-signature' } })
    } else {
      throw new Error(`Unsupported fake-anthropic content block: ${block.type}`)
    }
    sse(res, 'content_block_stop', { index })
  }
  sse(res, 'message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } })
  sse(res, 'message_stop', {})
  res.end()
}

/**
 * options:
 *   models      model objects for GET /v1/models (default DEFAULT_ANTHROPIC_MODELS)
 *   pageSize    force pagination of /v1/models (default: the client's ?limit)
 *   text        default reply text for /v1/messages
 *   responder   async (record, res) => spec | true | undefined  (see README)
 */
export async function createFakeAnthropic({ models = DEFAULT_ANTHROPIC_MODELS, pageSize, text, responder } = {}) {
  const requests = []
  const unexpected = []
  const queue = []
  let currentResponder = responder

  async function reply(res, record, spec) {
    if (spec.handle) return spec.handle(res, record)
    if (spec.json !== undefined || (spec.status && spec.status !== 200)) {
      return sendJson(res, spec.status ?? 200, spec.json ?? {}, spec.headers)
    }
    if (spec.delayBeforeMs) await delay(spec.delayBeforeMs)
    return sendAnthropicMessage(res, record.body ?? {}, { text, ...spec })
  }

  const server = await startLoopbackServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture')
    const { raw, body } = await readBody(req)
    const record = { index: requests.length, at: Date.now(), method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: { ...req.headers }, body, raw }
    requests.push(record)
    const queued = queue.findIndex(item => item.path === record.path && (!item.method || item.method === record.method))
    if (queued !== -1) return reply(res, record, queue.splice(queued, 1)[0].spec)
    if (currentResponder) {
      const spec = await currentResponder(record, res)
      if (spec === true || res.headersSent || res.writableEnded) return
      if (spec) return reply(res, record, spec)
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 20, pageSize ?? Number.MAX_SAFE_INTEGER))
      const afterId = url.searchParams.get('after_id')
      const start = afterId ? models.findIndex(model => model.id === afterId) + 1 : 0
      const page = models.slice(start, start + limit)
      return sendJson(res, 200, { data: page, has_more: start + limit < models.length, first_id: page[0]?.id ?? null, last_id: page.at(-1)?.id ?? null })
    }
    if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') return sendJson(res, 200, { input_tokens: 120 })
    if (req.method === 'POST' && url.pathname === '/v1/messages') return reply(res, record, {})
    unexpected.push(`${req.method} ${url.pathname}`)
    return sendJson(res, 404, { type: 'error', error: { type: 'not_found_error', message: `Unknown fake-anthropic endpoint: ${url.pathname}` } })
  }, { unexpected })

  return {
    origin: server.origin,
    requests,
    unexpected,
    /** The next request to `path` (default POST /v1/messages) gets `spec`. FIFO. */
    enqueue(spec, { path = '/v1/messages', method } = {}) { queue.push({ spec, path, method }) },
    setResponder(fn) { currentResponder = fn },
    messageRequests: () => requests.filter(record => record.method === 'POST' && record.path === '/v1/messages'),
    modelRequests: () => requests.filter(record => record.method === 'GET' && record.path === '/v1/models'),
    close: () => server.close(),
  }
}
