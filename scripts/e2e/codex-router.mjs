import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'

export const CODEX_FIXTURE_TOKEN = 'codex-e2e-synthetic-token'
export const CODEX_FIXTURE_ACCOUNT = 'codex-e2e-account'
export const CODEX_FIXTURE_README = 'CODEX_E2E_README_CONTENT: the fixture workspace is isolated and deterministic.'

const CODEX_E2E_SCENARIOS = [
  'CODEX_E2E_SIMPLE',
  'CODEX_E2E_FOLLOWUP',
  'CODEX_E2E_TOOL',
  'CODEX_E2E_LONG',
  'CODEX_E2E_EMPTY_RECOVER',
  'CODEX_E2E_EMPTY_EXHAUST',
  'CODEX_E2E_HTTP_429',
  'CODEX_E2E_HTTP_401',
  'CODEX_E2E_ABORT_STREAM',
  'CODEX_E2E_RECOVERY',
]

function latestScenarioMarker(text) {
  let latestMarker
  let latestPosition = -1
  for (const marker of CODEX_E2E_SCENARIOS) {
    const position = text.lastIndexOf(marker)
    if (position > latestPosition) {
      latestMarker = marker
      latestPosition = position
    }
  }
  return latestMarker
}

function findUnsupportedSchemaKeywords(schema, path = '$') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return []
  const errors = []
  for (const key of ['minProperties', 'maxProperties', 'dependentRequired', 'dependentSchemas', 'not']) {
    if (key in schema) errors.push(`${path}.${key} is unsupported in Codex strict schemas`)
  }
  if (schema.type === 'object') {
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
    if (schema.additionalProperties !== false) errors.push(`${path}.additionalProperties must be false`)
    if (!Array.isArray(schema.required)) errors.push(`${path}.required must be an array`)
    else for (const name of Object.keys(properties)) if (!schema.required.includes(name)) errors.push(`${path}.required omits ${name}`)
    for (const [name, child] of Object.entries(properties)) errors.push(...findUnsupportedSchemaKeywords(child, `${path}.properties.${name}`))
  }
  if (schema.items) errors.push(...findUnsupportedSchemaKeywords(schema.items, `${path}.items`))
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(schema[key])) schema[key].forEach((child, index) => errors.push(...findUnsupportedSchemaKeywords(child, `${path}.${key}[${index}]`)))
  return errors
}

function validateCodexRequest(req, body, headers, { anyEffort = false } = {}) {
  const problems = []
  const isStructuredTask = body.text?.format?.type === 'json_schema'
  if (req.method !== 'POST' || new URL(req.url, 'http://fixture').pathname !== '/backend-api/codex/responses') problems.push('request must be POST /backend-api/codex/responses')
  if (headers.authorization !== `Bearer ${CODEX_FIXTURE_TOKEN}`) problems.push('authorization header did not use the isolated Codex fixture credential')
  if (headers['chatgpt-account-id'] !== CODEX_FIXTURE_ACCOUNT) problems.push('chatgpt-account-id header is missing or wrong')
  if (headers.originator !== 'verboo') problems.push('originator header must be verboo')
  if (!headers['content-type']?.includes('application/json')) problems.push('content-type must be JSON')
  if (body.model !== 'gpt-5.5') problems.push(`expected resolved model gpt-5.5, received ${String(body.model)}`)
  if (body.stream !== true) problems.push('Codex requests must stream')
  if (body.store !== false) problems.push('Codex requests must set store=false')
  if (!Number.isSafeInteger(body.max_output_tokens) || body.max_output_tokens < 1024) problems.push('max_output_tokens must be an integer >= 1024')
  if (!anyEffort && !isStructuredTask && body.reasoning?.effort !== 'high') problems.push('user inference must preserve the explicitly selected high reasoning effort')
  if (!anyEffort && body.reasoning?.effort && body.reasoning.effort !== 'high') problems.push('Codex fixture must not downgrade reasoning below high')
  if (!Array.isArray(body.input) || body.input.length === 0) problems.push('input must contain the user conversation')
  if (!isStructuredTask && (!Array.isArray(body.tools) || body.tools.length < 5)) problems.push('expected the CLI toolset to be present in the Codex inference request')
  if (isStructuredTask && Array.isArray(body.tools) && body.tools.length > 0) problems.push('structured session-title requests must remain tool-free')
  if (Array.isArray(body.tools)) {
    for (const [index, tool] of body.tools.entries()) {
      if (tool.type !== 'function' || tool.strict !== true) problems.push(`tool ${index} is not a strict function tool`)
      problems.push(...findUnsupportedSchemaKeywords(tool.parameters, `tools[${index}].parameters`))
    }
  }
  if (!body.instructions || typeof body.instructions !== 'string') problems.push('system instructions were not forwarded')
  return problems
}

function inputText(input) {
  const pieces = []
  for (const item of Array.isArray(input) ? input : []) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) if (typeof part.text === 'string') pieces.push(part.text)
    }
    if (item.type === 'function_call_output') {
      if (typeof item.output === 'string') pieces.push(item.output)
      else if (Array.isArray(item.output)) for (const part of item.output) if (typeof part.text === 'string') pieces.push(part.text)
    }
  }
  return pieces.join('\n')
}

function latestUserText(input) {
  for (const item of [...(Array.isArray(input) ? input : [])].reverse()) {
    if (item.type !== 'message' || item.role !== 'user' || !Array.isArray(item.content)) continue
    return item.content.map(part => typeof part.text === 'string' ? part.text : '').join('\n')
  }
  return ''
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
}

function beginResponse(res, id) {
  sse(res, 'response.created', { response: { id, status: 'in_progress', output: [] } })
}

function completeResponse(res, id, output, usage = { input_tokens: 320, output_tokens: 24, input_tokens_details: { cached_tokens: 40 } }) {
  sse(res, 'response.completed', { response: { id, status: 'completed', output, usage } })
  res.end()
}

async function sendText(res, id, text, { chunkSize = 72, delayMs = 0 } = {}) {
  beginResponse(res, id)
  const itemId = `msg_${id}`
  sse(res, 'response.output_item.added', { output_index: 0, item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } })
  sse(res, 'response.content_part.added', { item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } })
  for (let index = 0; index < text.length; index += chunkSize) {
    if (res.destroyed) return
    sse(res, 'response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta: text.slice(index, index + chunkSize) })
    if (delayMs) await delay(delayMs)
  }
  sse(res, 'response.output_item.done', { output_index: 0, item: { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] } })
  completeResponse(res, id, [{ id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }], { input_tokens: 320, output_tokens: Math.max(24, Math.ceil(text.length / 4)), input_tokens_details: { cached_tokens: 40 } })
}

export function createCodexFixtureCredentialRecord() {
  return {
    codex: {
      apiKey: CODEX_FIXTURE_TOKEN,
      accessToken: CODEX_FIXTURE_TOKEN,
      accountId: CODEX_FIXTURE_ACCOUNT,
    },
  }
}

export async function createCodexRouter({ projectRoot, onChunkDelayMs = 15, anyEffort = false } = {}) {
  const requests = []
  const catalogRequests = []
  const violations = []
  const abortedRequests = []
  const scenarioAttempts = new Map()
  let sequence = 0

  const server = createServer(async (req, res) => {
    const chunks = []
    try {
      const pathname = new URL(req.url, 'http://fixture').pathname
      if (req.method === 'GET' && pathname === '/backend-api/codex/models') {
        const catalogRecord = {
          at: Date.now(),
          authorizationPresent: Boolean(req.headers.authorization),
          accountId: req.headers['chatgpt-account-id'],
          originator: req.headers.originator,
          clientVersion: new URL(req.url, 'http://fixture').searchParams.get('client_version'),
        }
        catalogRequests.push(catalogRecord)
        const catalogProblems = []
        if (req.headers.authorization !== `Bearer ${CODEX_FIXTURE_TOKEN}`) catalogProblems.push('Codex model catalog request did not use the isolated credential')
        if (req.headers['chatgpt-account-id'] !== CODEX_FIXTURE_ACCOUNT) catalogProblems.push('Codex model catalog request omitted the account ID')
        if (req.headers.originator !== 'verboo') catalogProblems.push('Codex model catalog request omitted the Verboo originator')
        if (!catalogRecord.clientVersion) catalogProblems.push('Codex model catalog request omitted client_version')
        if (catalogProblems.length) {
          violations.push(...catalogProblems)
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: catalogProblems.join('; ') } }))
          return
        }
        if (req.headers['if-none-match'] === '"codex-e2e-v1"') {
          res.writeHead(304, { etag: '"codex-e2e-v1"' }).end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json', etag: '"codex-e2e-v1"' }).end(JSON.stringify({ models: [{
          slug: 'gpt-5.5',
          display_name: 'gpt-5.5',
          description: 'Isolated Codex end-to-end fixture model',
          default_reasoning_level: 'high',
          supported_reasoning_levels: [
            { effort: 'low', description: 'low' },
            { effort: 'medium', description: 'medium' },
            { effort: 'high', description: 'high' },
            { effort: 'xhigh', description: 'extra high' },
          ],
          visibility: 'list',
          supported_in_api: true,
          priority: 1,
          context_window: 256000,
        }] }))
        return
      }
      for await (const chunk of req) chunks.push(chunk)
      const rawBody = Buffer.concat(chunks).toString('utf8')
      let body
      try { body = JSON.parse(rawBody) } catch { body = undefined }
      if (!body) {
        violations.push('request body was not valid JSON')
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'invalid JSON' } }))
        return
      }
      const id = `codex-fixture-${++sequence}`
      const problems = validateCodexRequest(req, body, req.headers, { anyEffort })
      const record = { id, path: new URL(req.url, 'http://fixture').pathname, at: Date.now(), currentUserPrompt: latestUserText(body.input), headers: { authorizationPresent: Boolean(req.headers.authorization), accountId: req.headers['chatgpt-account-id'], originator: req.headers.originator }, body }
      requests.push(record)
      if (problems.length) {
        violations.push(...problems.map(problem => `${id}: ${problem}`))
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: problems.join('; ') } }))
        return
      }

      const text = inputText(body.input)
      const currentPrompt = latestUserText(body.input)
      const scenario = latestScenarioMarker(currentPrompt)
      if (body.text?.format?.type === 'json_schema') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        await sendText(res, id, JSON.stringify({ title: 'Codex fixture session' }), { delayMs: onChunkDelayMs })
        return
      }
      const attemptKey = ['CODEX_E2E_EMPTY_RECOVER', 'CODEX_E2E_EMPTY_EXHAUST'].find(marker => scenario === marker)
      const attempt = attemptKey ? (scenarioAttempts.get(attemptKey) ?? 0) + 1 : 1
      if (attemptKey) scenarioAttempts.set(attemptKey, attempt)

      if (scenario === 'CODEX_E2E_HTTP_429') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' }).end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'Codex fixture rate limit: retry after recovery prompt.' } }))
        return
      }
      if (scenario === 'CODEX_E2E_HTTP_401') {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { type: 'authentication_error', message: 'Codex fixture rejected the credential.' } }))
        return
      }
      if (scenario === 'CODEX_E2E_EMPTY_EXHAUST') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        beginResponse(res, id)
        completeResponse(res, id, [], { input_tokens: 12, output_tokens: 0 })
        return
      }
      if (scenario === 'CODEX_E2E_EMPTY_RECOVER' && attempt === 1) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        beginResponse(res, id)
        completeResponse(res, id, [], { input_tokens: 12, output_tokens: 0 })
        return
      }
      if (scenario === 'CODEX_E2E_ABORT_STREAM') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        res.flushHeaders()
        const onClose = () => { if (!res.writableEnded) abortedRequests.push(id) }
        res.once('close', onClose)
        beginResponse(res, id)
        await delay(100)
        const itemId = `msg_${id}`
        sse(res, 'response.output_item.added', { output_index: 0, item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } })
        await delay(100)
        sse(res, 'response.content_part.added', { item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } })
        await delay(100)
        sse(res, 'response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta: 'CODEX_E2E_PARTIAL_BEFORE_CANCEL\n' })
        await delay(15_000)
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })

      if (scenario === 'CODEX_E2E_SIMPLE') {
        await sendText(res, id, 'CODEX_E2E_SIMPLE_REPLY: the Codex transport responded through the CLI.', { delayMs: onChunkDelayMs })
        return
      }
      if (scenario === 'CODEX_E2E_FOLLOWUP') {
        if (!text.includes('CODEX_E2E_SIMPLE_REPLY')) violations.push(`${id}: the prior assistant turn was missing from follow-up input`)
        await sendText(res, id, 'CODEX_E2E_FOLLOWUP_REPLY: prior conversation context is present.', { delayMs: onChunkDelayMs })
        return
      }
      if (scenario === 'CODEX_E2E_TOOL') {
        const toolResult = body.input.find(item => item.type === 'function_call_output')
        if (!toolResult) {
          const readTool = body.tools.find(tool => tool.name === 'Read')
          if (!readTool) {
            violations.push(`${id}: the CLI did not advertise the Read tool`)
            res.end()
            return
          }
          const args = JSON.stringify({ file_path: join(projectRoot, 'README.md') })
          const item = { id: `fc_item_${id}`, call_id: `call_${id}`, type: 'function_call', name: readTool.name, arguments: args }
          beginResponse(res, id)
          sse(res, 'response.output_item.added', { output_index: 0, item: { ...item, arguments: '' } })
          for (const piece of [args.slice(0, 12), args.slice(12, 29), args.slice(29)]) {
            sse(res, 'response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: piece })
            await delay(onChunkDelayMs)
          }
          sse(res, 'response.output_item.done', { output_index: 0, item })
          completeResponse(res, id, [item], { input_tokens: 400, output_tokens: 32 })
          return
        }
        const serializedOutput = JSON.stringify(toolResult.output)
        if (!serializedOutput.includes('CODEX_E2E_README_CONTENT')) violations.push(`${id}: the Read tool result was missing from function_call_output`)
        await sendText(res, id, 'CODEX_E2E_TOOL_REPLY: CODEX_E2E_README_CONTENT was read from the fixture workspace.', { delayMs: onChunkDelayMs })
        return
      }
      if (scenario === 'CODEX_E2E_LONG') {
        const bodyText = Array.from({ length: 160 }, (_, index) => `LONG_SEGMENT_${String(index + 1).padStart(3, '0')}_complete streamed content for a realistic multiline report.\n`).join('')
        await sendText(res, id, `${bodyText}CODEX_E2E_LONG_FINAL_MARKER`, { chunkSize: 84, delayMs: 75 })
        return
      }
      if (scenario === 'CODEX_E2E_EMPTY_RECOVER') {
        await sendText(res, id, 'CODEX_E2E_EMPTY_RECOVERED_AFTER_ONE_RETRY.', { delayMs: onChunkDelayMs })
        return
      }
      if (scenario === 'CODEX_E2E_RECOVERY') {
        await sendText(res, id, 'CODEX_E2E_RECOVERY_REPLY: the interactive session remained usable.', { delayMs: onChunkDelayMs })
        return
      }
      if (currentPrompt.includes('memory extraction subagent')) {
        await sendText(res, id, 'No new durable memory updates are required for this fixture session.', { delayMs: onChunkDelayMs })
        return
      }
      violations.push(`${id}: no fixture response was defined for the user input`)
      res.end()
    } catch (error) {
      if (!req.aborted && error?.code !== 'ECONNRESET') violations.push(`fixture server error: ${error?.stack ?? error}`)
      if (!res.destroyed) res.destroy()
    }
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    catalogRequests,
    violations,
    abortedRequests,
    async close() {
      const closed = new Promise(resolve => server.close(resolve))
      server.closeAllConnections()
      await closed
    },
  }
}
