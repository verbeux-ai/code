import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'

// Optional for human-session scenarios:
//   models           ids or model objects served by GET .../models (default [model])
//   agentModelRoles  merged over the default agent_model_roles (e.g. { classifier: 'fixture-classifier' })
//   routerHandler    async (req, body, res) => true | undefined. Runs before the
//                    default behavior for every endpoint (req.pathname/req.query
//                    are set, body is parsed JSON, raw text or undefined). Return
//                    true or write the response to replace the default.
export async function createFakeRouter({ agents = 2, omitUsage = false, zeroUsage = false, partialUsage = false, stall = false, background = false, childFailure = false, childToolLoop = false, routedCompletion = false, model: configuredModel, models: modelList, agentModelRoles, routerHandler } = {}) {
  const requests = []
  // Every request (any endpoint) with headers; `requests` keeps only chat bodies.
  const allRequests = []
  const unexpected = []
  let sequence = 0
  const activeAgents = new Set()
  const activeRequests = new Set()
  const model = routedCompletion ? 'jev-router' : configuredModel ?? 'fixture-model'
  async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://fixture')
    const path = url.pathname
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)) }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString()
    const record = { index: allRequests.length, at: Date.now(), method: req.method, path, query: Object.fromEntries(url.searchParams), headers: { ...req.headers }, body: undefined }
    allRequests.push(record)
    let body
    if (path === '/router/v1/chat/completions') {
      body = JSON.parse(raw)
      requests.push(body)
    } else if (raw) {
      try { body = JSON.parse(raw) } catch { body = raw }
    }
    record.body = body
    if (routerHandler) {
      req.pathname = path
      req.query = record.query
      const handled = await routerHandler(req, body, res)
      if (handled === true || res.headersSent || res.writableEnded) return
    }
    if (path === '/') return json({ ok: true })
    if (path === '/api/claude_code/settings') return json({ settings: {} })
    if (path === '/api/plugins/marketplace.json') return json({ name: 'fixture', owner: { name: 'Fixture' }, plugins: [] })
    if (path.endsWith('/models')) return json({ data: (modelList ?? [model]).map(entry => typeof entry === 'string' ? { id: entry, object: 'model' } : entry), agent_model_roles: { explore: model, balanced: model, powerful: model, ...agentModelRoles } })
    if (path === '/api/me') return json({ data: { id: '11111111-1111-4111-8111-111111111111', email: 'fixture@example.test', name: 'Fixture', confirmed: true } })
    if (path === '/api/me/subscriptions') return json({ data: [{ id: '11111111-1111-4111-8111-111111111111', groupId: '22222222-2222-4222-8222-222222222222', status: 'active', currentPeriodEnd: '2099-01-01T00:00:00Z' }] })
    if (path === '/api/me/terms/status') return json({ data: { configured: false, mustAccept: false, pendingReacceptance: false } })
    if (path !== '/router/v1/chat/completions') { unexpected.push(path); res.statusCode = 404; return json({ error: { message: `Unknown fixture endpoint: ${path}` } }) }
    const id = `fixture-${++sequence}`
    const prompt = body.messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.content)).join('\n')
    const isChild = prompt.includes('AGENT_FIXTURE_')
    if (isChild && childFailure) {
      res.statusCode = 400
      return json({ error: { type: 'invalid_request_error', message: 'Fixture child request rejected' } })
    }
    if (isChild) { activeAgents.add(id); res.once('close', () => activeAgents.delete(id)) }
    const hasResult = body.messages.some(message => message.role === 'tool')
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...(routedCompletion && { 'X-Verboo-Selected-Model': 'glm-5.3-flash' }) })
    const emit = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason }], ...(usage && { usage }) })}\n\n`)
    emit({ role: 'assistant' })
    if (routedCompletion && body.tools?.length) {
      emit({ reasoning_content: 'Synthetic hidden reasoning.' })
      emit({ content: `Oi! E2E_ROUTED_COMPLETE ${id}` })
      emit({}, 'stop', { prompt_tokens: 10, completion_tokens: 4 })
    } else if (isChild && childToolLoop) {
      emit({ tool_calls: [{ index: 0, id: `read-${sequence}`, type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: 'README.md' }) } }] })
      emit({}, 'tool_calls', { prompt_tokens: 120, completion_tokens: 24 })
    } else if (!isChild && !hasResult && body.tools?.length) {
      const name = body.tools.find(tool => ['Agent', 'Task'].includes(tool.function.name))?.function.name
      if (!name) { unexpected.push('Agent tool missing from actual query'); res.end(); return }
      for (let index = 0; index < agents; index++) {
        const args = JSON.stringify({ description: `Worker ${index} 日本語 🚀`, subagent_type: childToolLoop ? 'fixture-limited' : 'general-purpose', prompt: `AGENT_FIXTURE_${index}: inspect the fixture and report.`, ...(background && { run_in_background: true }) })
        emit({ tool_calls: [{ index, id: `call-${index}`, type: 'function', function: { name, arguments: args.slice(0, 25) } }] })
        emit({ tool_calls: [{ index, function: { arguments: args.slice(25) } }] })
      }
      emit({}, 'tool_calls', { prompt_tokens: 120, completion_tokens: 24 })
    } else {
      const content = !body.tools?.length ? '{"title":"Fixture agent test"}' : isChild ? `Worker report 日本語 🚀 ${'reading fixture safely. '.repeat(12)}` : 'E2E_COMPLETE'
      for (let index = 0; index < content.length; index += 16) {
        if (res.destroyed) break
        emit({ content: content.slice(index, index + 16) })
        await delay(isChild ? 100 : 5)
      }
      if (stall && isChild) return
      emit({}, 'stop', omitUsage ? undefined : zeroUsage ? { prompt_tokens: 0, completion_tokens: 0 } : partialUsage ? { prompt_tokens: 120 } : { prompt_tokens: 120, completion_tokens: 24, prompt_tokens_details: { cached_tokens: 5 } })
    }
    res.end('data: [DONE]\n\n')
  }
  const server = createServer((req, res) => {
    const handling = handleRequest(req, res).catch(error => {
      // Stopping the CLI may abort a request while its body is arriving.
      // HTTP event listeners do not consume rejected async promises themselves.
      if (req.aborted && error?.code === 'ECONNRESET') return
      unexpected.push(`Fixture handler failed: ${error?.message ?? String(error)}`)
      res.destroy()
    }).finally(() => activeRequests.delete(handling))
    activeRequests.add(handling)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${server.address().port}`, requests, allRequests, unexpected, activeAgents, activeRequests,
    async close() {
      const closed = new Promise(resolve => server.close(resolve))
      server.closeAllConnections()
      await closed
      await Promise.all([...activeRequests])
    },
  }
}
