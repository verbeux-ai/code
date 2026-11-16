// Loopback proxy that lets a scenario answer any request itself (handler) and
// forwards the rest, unchanged and streamed, to an existing fixture server.
// startCli uses it for `codexHandler` in front of codex-router.mjs.
import { readBody, startLoopbackServer } from './http.mjs'

const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'expect', 'upgrade'])

export async function createInterceptingProxy({ target, handler }) {
  const requests = []
  const unexpected = []
  const server = await startLoopbackServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture')
    const { raw, body } = await readBody(req)
    requests.push({ index: requests.length, at: Date.now(), method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: { ...req.headers }, body, handled: false })
    if (handler) {
      req.pathname = url.pathname
      req.query = Object.fromEntries(url.searchParams)
      const handled = await handler(req, body, res)
      if (handled === true || res.headersSent || res.writableEnded) {
        requests.at(-1).handled = true
        return
      }
    }
    const abort = new AbortController()
    res.once('close', () => { if (!res.writableEnded) abort.abort() })
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !HOP_BY_HOP.has(name)))
    let upstream
    try {
      upstream = await fetch(`${target}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw, signal: abort.signal })
    } catch (error) {
      if (abort.signal.aborted) return
      throw error
    }
    const responseHeaders = Object.fromEntries([...upstream.headers].filter(([name]) => !HOP_BY_HOP.has(name) && name !== 'content-encoding'))
    res.writeHead(upstream.status, responseHeaders)
    if (typeof res.flushHeaders === 'function') res.flushHeaders()
    try {
      if (upstream.body) for await (const chunk of upstream.body) res.write(chunk)
      res.end()
    } catch (error) {
      if (!abort.signal.aborted) throw error
    }
  }, { unexpected })
  return { origin: server.origin, requests, unexpected, close: () => server.close() }
}
