// Fake OpenAI API (api.openai.com) for PTY fixtures. startCli({ openai })
// starts it and sets CLI_E2E_OPENAI_ORIGIN so the preload redirects
// api.openai.com here. The CLI calls https://api.openai.com/v1/..., so the
// paths seen here keep the /v1 prefix.
import { setTimeout as delay } from 'node:timers/promises'
import { readBody, sendChatCompletion, sendJson, startLoopbackServer } from './http.mjs'

// Includes non-chat ids on purpose: the CLI must filter them out of /model.
export const DEFAULT_OPENAI_MODELS = ['gpt-5.5', 'gpt-5.5-mini', 'text-embedding-3-small', 'whisper-1']

function errorEnvelope(status, type, code, message, headers = {}) {
  return { status, json: { error: { message, type, param: null, code } }, headers }
}

/** Real OpenAI error bodies, usable as responder/enqueue specs. */
export const openaiErrors = {
  invalidApiKey: () => errorEnvelope(401, 'invalid_request_error', 'invalid_api_key', 'Incorrect API key provided: sk-fixt***********************here. You can find your API key at https://platform.openai.com/account/api-keys.'),
  insufficientQuota: () => errorEnvelope(429, 'insufficient_quota', 'insufficient_quota', 'You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.'),
  rateLimitExceeded: (retryAfterSeconds = 1) => errorEnvelope(429, 'tokens', 'rate_limit_exceeded', 'Rate limit reached for gpt-5.5 in organization org-fixture on tokens per min (TPM): Limit 30000, Used 29500, Requested 1200. Please try again in 1.4s. Visit https://platform.openai.com/account/rate-limits to learn more.', { 'retry-after': String(retryAfterSeconds), 'x-ratelimit-limit-tokens': '30000', 'x-ratelimit-remaining-tokens': '500', 'x-ratelimit-reset-tokens': '1.4s' }),
  serverError: () => errorEnvelope(500, 'server_error', null, 'The server had an error while processing your request. Sorry about that!'),
  modelNotFound: (model = 'gpt-unknown') => errorEnvelope(404, 'invalid_request_error', 'model_not_found', `The model \`${model}\` does not exist or you do not have access to it.`),
}

/**
 * options:
 *   models      ids (or model objects) for GET /v1/models (default DEFAULT_OPENAI_MODELS)
 *   text        default reply text for /v1/chat/completions
 *   responder   async (record, res) => spec | true | undefined  (see README)
 */
export async function createFakeOpenAI({ models = DEFAULT_OPENAI_MODELS, text, responder } = {}) {
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
    return sendChatCompletion(res, record.body ?? {}, { text: text ?? 'OPENAI_FIXTURE_REPLY', ...spec })
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
      return sendJson(res, 200, { object: 'list', data: models.map(model => typeof model === 'string' ? { id: model, object: 'model', created: 1_750_000_000, owned_by: 'openai' } : model) })
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') return reply(res, record, {})
    unexpected.push(`${req.method} ${url.pathname}`)
    return sendJson(res, 404, { error: { message: `Unknown fake OpenAI endpoint: ${url.pathname}`, type: 'invalid_request_error', param: null, code: 'unknown_url' } })
  }, { unexpected })

  return {
    origin: server.origin,
    requests,
    unexpected,
    /** The next request to `path` (default POST /v1/chat/completions) gets `spec`. FIFO. */
    enqueue(spec, { path = '/v1/chat/completions', method } = {}) { queue.push({ spec, path, method }) },
    setResponder(fn) { currentResponder = fn },
    chatRequests: () => requests.filter(record => record.method === 'POST' && record.path === '/v1/chat/completions'),
    modelRequests: () => requests.filter(record => record.method === 'GET' && record.path === '/v1/models'),
    close: () => server.close(),
  }
}
