// Test-only Node preload. The installed package, parser, auth and query loop stay real.
import { HttpRequestInterceptor } from '@mswjs/interceptors/http'
import { appendFileSync } from 'node:fs'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { basename } from 'node:path'

const networkLog = process.env.CLI_E2E_NETWORK_LOG

// Trace executable names and timings only; never record arguments or input,
// which may contain credentials. This also locates synchronous startup stalls.
const processLog = process.env.CLI_E2E_PROCESS_LOG
if (processLog) {
  const spawnSync = childProcess.spawnSync
  childProcess.spawnSync = (...args) => {
    const started = Date.now()
    appendFileSync(processLog, `${JSON.stringify({ event: 'spawnSync', file: args[0], at: started })}\n`)
    try { return spawnSync(...args) }
    finally { appendFileSync(processLog, `${JSON.stringify({ event: 'spawnSync:end', file: args[0], durationMs: Date.now() - started })}\n`) }
  }
  const spawn = childProcess.spawn
  childProcess.spawn = (...args) => {
    const child = spawn(...args)
    const started = Date.now()
    appendFileSync(processLog, `${JSON.stringify({ event: 'spawn', file: args[0], pid: child.pid, at: started })}\n`)
    child.once('exit', code => appendFileSync(processLog, `${JSON.stringify({ event: 'spawn:exit', file: args[0], pid: child.pid, code, durationMs: Date.now() - started })}\n`))
    return child
  }
  syncBuiltinESMExports()
}

// Subprocesses bypass the HTTP interceptor below. Record every
// network-capable tool the CLI itself starts against a remote into
// CLI_E2E_SUBPROCESS_NETWORK_LOG: only the tool, its subcommand and the target
// origin+path are logged, never credentials or query strings. The harness env
// also disables git/npm network transports, so these calls fail offline
// instead of reaching the Internet.
const subprocessNetworkLog = process.env.CLI_E2E_SUBPROCESS_NETWORK_LOG
const NETWORK_TOOLS = new Set(['curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat'])
const GH_NETWORK_SUBCOMMANDS = new Set(['api', 'repo', 'pr', 'issue', 'secret', 'release', 'run', 'workflow', 'search', 'gist', 'label', 'codespace', 'extension'])
const GIT_NETWORK_SUBCOMMANDS = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote', 'submodule', 'archive'])
const PACKAGE_MANAGERS = new Set(['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx'])
const PACKAGE_NETWORK_SUBCOMMANDS = new Set(['install', 'i', 'add', 'ci', 'update', 'upgrade', 'view', 'info', 'show', 'outdated', 'search', 'exec', 'x', 'dlx', 'ping', 'audit', 'publish', 'create', 'init'])
const loopbackHost = host => !host || host === 'localhost' || host === '[::1]' || host === '::1' || host.startsWith('127.')
function remoteTarget(arg) {
  if (typeof arg !== 'string') return undefined
  const scp = /^[\w.-]+@([\w.-]+):(?!\/\/)/.exec(arg)
  if (scp) return loopbackHost(scp[1]) ? undefined : `ssh://${scp[1]}`
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) return undefined
  try {
    const url = new URL(arg)
    if (url.protocol === 'file:' || loopbackHost(url.hostname)) return undefined
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch { return undefined }
}
function firstOperand(list) {
  for (let index = 0; index < list.length; index++) {
    if (/^-[Cc]$/.test(list[index])) { index++; continue }
    if (!list[index].startsWith('-')) return list[index]
  }
  return undefined
}
function scanSpawn(file, args) {
  if (!subprocessNetworkLog || typeof file !== 'string') return
  const tool = basename(file).replace(/\.(exe|cmd)$/i, '')
  const list = Array.isArray(args) ? args.filter(arg => typeof arg === 'string') : []
  const subcommand = firstOperand(list)
  const target = list.map(remoteTarget).find(Boolean)
  let entry
  if (NETWORK_TOOLS.has(tool)) entry = `${tool}${target ? ` ${target}` : ''}`
  else if (tool === 'gh' && (GH_NETWORK_SUBCOMMANDS.has(subcommand) || (subcommand === 'auth' && ['status', 'login', 'refresh'].includes(list[list.indexOf('auth') + 1])))) entry = `gh ${subcommand}`
  else if (tool === 'git' && (target || GIT_NETWORK_SUBCOMMANDS.has(subcommand))) entry = `git ${subcommand ?? ''}${target ? ` ${target}` : ''}`
  else if (PACKAGE_MANAGERS.has(tool) && (target || PACKAGE_NETWORK_SUBCOMMANDS.has(subcommand))) entry = `${tool} ${subcommand ?? ''}${target ? ` ${target}` : ''}`
  if (entry) appendFileSync(subprocessNetworkLog, `${entry.trim()}\n`)
}
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = childProcess[name]
  childProcess[name] = function (...callArgs) {
    try { scanSpawn(callArgs[0], callArgs[1]) } catch {}
    return original.apply(this, callArgs)
  }
}
syncBuiltinESMExports()

const origin = process.env.CLI_E2E_ORIGIN
if (!origin?.startsWith('http://127.0.0.1:')) throw new Error('Missing loopback fixture origin')
function optionalOrigin(name) {
  const value = process.env[name]
  if (value && !value.startsWith('http://127.0.0.1:')) throw new Error(`Invalid loopback fixture origin in ${name}`)
  return value || undefined
}
const codexOrigin = optionalOrigin('CLI_E2E_CODEX_ORIGIN')
const anthropicOrigin = optionalOrigin('CLI_E2E_ANTHROPIC_ORIGIN')
const openaiOrigin = optionalOrigin('CLI_E2E_OPENAI_ORIGIN')
// Real hostname -> local fixture. Hosts without a fixture stay blocked.
const redirects = new Map([
  ['code.verboo.ai', origin],
  ['chatgpt.com', codexOrigin],
  ['api.anthropic.com', anthropicOrigin],
  ['api.openai.com', openaiOrigin],
].filter(([, target]) => target))
const fixtureOrigins = new Set(redirects.values())

// Redirect fetch at its URL boundary so its real response stream and abort
// signal reach the local socket. Mock response piping loses post-header aborts.
const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  // Keep the caller's init: a chain of Request objects follows its signal through
  // weak references, and a garbage collection in the middle loses the abort.
  const isRequest = input instanceof Request
  const url = new URL(isRequest ? input.url : String(input))
  const targetOrigin = redirects.get(url.hostname)
  if (!targetOrigin) return realFetch(input, init)
  const target = `${targetOrigin}${url.pathname}${url.search}`
  return realFetch(isRequest ? new Request(target, input) : target, init)
}

const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'expect', 'upgrade', 'proxy-connection'])
const interceptor = new HttpRequestInterceptor()
interceptor.apply()
interceptor.on('request', async ({ request, controller }) => {
  const url = new URL(request.url)
  if (fixtureOrigins.has(url.origin)) return
  const targetOrigin = redirects.get(url.hostname)
  // chatgpt.com keeps its historical fetch-only redirect.
  if (!targetOrigin || url.hostname === 'chatgpt.com') {
    appendFileSync(networkLog, `${request.method} ${url.origin}${url.pathname}\n`)
    controller.respondWith(new Response('Unexpected external request in CLI fixture', { status: 503 }))
    return
  }
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.clone().arrayBuffer()
  // Forward the client's headers so fixtures can assert authentication,
  // versioning and User-Agent exactly as the fetch redirect above does.
  const headers = Object.fromEntries([...request.headers].filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase())))
  if (!headers['content-type'] && body) headers['content-type'] = 'application/json'
  const response = await fetch(`${targetOrigin}${url.pathname}${url.search}`, { method: request.method, body, signal: request.signal, headers })
  controller.respondWith(response)
})
