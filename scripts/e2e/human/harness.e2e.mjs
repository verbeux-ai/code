// Smoke test for the human-session harness extensions (README.md next to this file).
// Run: node --test --test-concurrency=1 scripts/e2e/human/harness.e2e.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { REAL_USER_TRAFFIC_ENV, startCli } from '../terminal.mjs'
import { pathToFileURL } from 'node:url'
import { claudeApiKeyCredential, githubModelsCredential, openaiApiKeyCredential } from './keyring.mjs'
import { anthropicErrors, createFakeAnthropic } from './fake-anthropic.mjs'
import { createFakeOpenAI, openaiErrors } from './fake-openai.mjs'
import { createFakeRouter } from '../fake-router.mjs'
import { hasToolResult, isClassifierRequest, sendChatCompletion, sendClassifierVerdict } from './http.mjs'

const ANTHROPIC_KEY = 'sk-ant-api03-harnessfixture000000000000000AAAA'
const OPENAI_KEY = 'sk-proj-harnessfixture00000000000000BBBB'

async function sseEvents(response) {
  const text = await response.text()
  return text.split('\n\n').filter(Boolean).map(block => {
    const event = /^event: (.*)$/m.exec(block)?.[1]
    const data = /^data: (.*)$/m.exec(block)?.[1]
    return { event, data: data === '[DONE]' ? data : data && JSON.parse(data) }
  })
}

test('fake-anthropic and fake-openai speak the real wire formats', async () => {
  const anthropic = await createFakeAnthropic({ pageSize: 1 })
  const openai = await createFakeOpenAI()
  try {
    const page1 = await (await fetch(`${anthropic.origin}/v1/models?limit=1000`)).json()
    assert.equal(page1.data.length, 1)
    assert.equal(page1.has_more, true)
    const page2 = await (await fetch(`${anthropic.origin}/v1/models?limit=1000&after_id=${page1.last_id}`)).json()
    assert.equal(page2.has_more, false)
    assert.notEqual(page2.data[0].id, page1.data[0].id)

    const stream = await fetch(`${anthropic.origin}/v1/messages`, { method: 'POST', headers: { 'x-api-key': ANTHROPIC_KEY }, body: JSON.stringify({ model: 'claude-x', stream: true, messages: [] }) })
    const events = await sseEvents(stream)
    assert.deepEqual(events.map(event => event.event), ['message_start', 'ping', 'content_block_start', ...Array(Math.ceil('ANTHROPIC_FIXTURE_REPLY'.length / 16)).fill('content_block_delta'), 'content_block_stop', 'message_delta', 'message_stop'])
    assert.equal(events.find(event => event.event === 'message_delta').data.usage.output_tokens, 24)
    assert.equal(anthropic.requests.at(-1).headers['x-api-key'], ANTHROPIC_KEY)

    anthropic.enqueue(anthropicErrors.creditBalanceTooLow())
    const credit = await fetch(`${anthropic.origin}/v1/messages`, { method: 'POST', body: JSON.stringify({ stream: true }) })
    assert.equal(credit.status, 400)
    assert.match((await credit.json()).error.message, /credit balance is too low/)
    const plain = await (await fetch(`${anthropic.origin}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'claude-x' }) })).json()
    assert.equal(plain.type, 'message')
    assert.equal(plain.content[0].text, 'ANTHROPIC_FIXTURE_REPLY')

    openai.enqueue(openaiErrors.insufficientQuota())
    const quota = await fetch(`${openai.origin}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ stream: true }) })
    assert.equal(quota.status, 429)
    assert.equal((await quota.json()).error.code, 'insufficient_quota')
    const chunks = await sseEvents(await fetch(`${openai.origin}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'gpt-5.5', stream: true }) }))
    assert.equal(chunks.at(-1).data, '[DONE]')
    assert.equal(chunks.at(-2).data.choices[0].finish_reason, 'stop')
    assert.equal(chunks.map(chunk => chunk.data?.choices?.[0]?.delta?.content ?? '').join(''), 'OPENAI_FIXTURE_REPLY')
    assert.deepEqual(anthropic.unexpected, [])
    assert.deepEqual(openai.unexpected, [])
  } finally {
    await anthropic.close()
    await openai.close()
  }
})

// Runs under the real preload, with no CLI, so each transport is proven on its own.
const PRELOAD_PROBE = `
import http from 'node:http'
import https from 'node:https'
const viaHttp = (module, url, options = {}, body) => new Promise(done => {
  const request = module.request(url, options, response => { let text = ''; response.on('data', chunk => { text += chunk }); response.on('end', () => done({ status: response.statusCode, text })) })
  request.on('error', error => done({ error: error.code ?? error.message }))
  if (body) request.write(body)
  request.end()
})
const viaFetch = async (url, init) => { const response = await fetch(url, init); return { status: response.status, text: await response.text() } }
const results = {
  fetchAnthropic: await viaFetch('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': 'probe-fetch-anthropic' } }),
  fetchOpenAI: await viaFetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer probe-fetch-openai' }, body: JSON.stringify({ model: 'gpt-5.5' }) }),
  httpAnthropic: await viaHttp(https, 'https://api.anthropic.com/v1/models', { headers: { 'x-api-key': 'probe-http-anthropic' } }),
  httpOpenAI: await viaHttp(https, 'https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer probe-http-openai' } }, JSON.stringify({ model: 'gpt-5.5' })),
  blockedFetch: await viaFetch('https://blocked-by-fixture.invalid/via-fetch'),
  blockedHttps: await viaHttp(https, 'https://blocked-by-fixture.invalid/via-https'),
  blockedHttp: await viaHttp(http, 'http://blocked-by-fixture.invalid/via-http'),
}
process.stdout.write(JSON.stringify(results))
`

test('transport preload: fetch and http.request both reach the fakes; other hosts are blocked and logged', { timeout: 60_000 }, async () => {
  const anthropic = await createFakeAnthropic()
  const openai = await createFakeOpenAI()
  const router = await createFakeRouter()
  const dir = await mkdtemp(join(tmpdir(), 'verboo-preload-probe-'))
  try {
    const log = join(dir, 'network.log')
    await writeFile(log, '')
    const child = spawn(process.execPath, ['--import', pathToFileURL(resolve('scripts/e2e/transport-preload.mjs')).href, '--input-type=module', '-e', PRELOAD_PROBE], {
      env: { PATH: process.env.PATH, HOME: dir, CLI_E2E_ORIGIN: router.origin, CLI_E2E_ANTHROPIC_ORIGIN: anthropic.origin, CLI_E2E_OPENAI_ORIGIN: openai.origin, CLI_E2E_NETWORK_LOG: log },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const exitCode = await new Promise(done => child.on('close', done))
    assert.equal(exitCode, 0, stderr)
    const results = JSON.parse(stdout)
    for (const name of ['fetchAnthropic', 'fetchOpenAI', 'httpAnthropic', 'httpOpenAI']) assert.equal(results[name].status, 200, `${name}: ${JSON.stringify(results[name])}`)
    for (const name of ['blockedFetch', 'blockedHttps', 'blockedHttp']) assert.equal(results[name].status, 503, `${name}: ${JSON.stringify(results[name])}`)
    assert.deepEqual(anthropic.modelRequests().map(record => record.headers['x-api-key']), ['probe-fetch-anthropic', 'probe-http-anthropic'])
    assert.deepEqual(openai.chatRequests().map(record => [record.headers.authorization, record.body.model]), [['Bearer probe-fetch-openai', 'gpt-5.5'], ['Bearer probe-http-openai', 'gpt-5.5']])
    assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), [
      'GET https://blocked-by-fixture.invalid/via-fetch',
      'GET https://blocked-by-fixture.invalid/via-https',
      'GET http://blocked-by-fixture.invalid/via-http',
    ])
  } finally {
    await anthropic.close()
    await openai.close()
    await router.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('isolation: startCli refuses the real profile and the variables that keep a run isolated', async () => {
  const real = homedir()
  await assert.rejects(startCli({ env: { HOME: real } }), /real profile/)
  await assert.rejects(startCli({ env: { VERBOO_CONFIG_DIR: join(real, '.verboo') } }), /real profile/)
  await assert.rejects(startCli({ env: { VERBOO_PROJECTS_DIR: join(real, '.claude/projects') } }), /real profile/)
  await assert.rejects(startCli({ cwd: join(real, '.claude') }), /real profile/)
  for (const name of ['HOME', 'PATH', 'CLI_E2E_KEYRING_DIR', 'CLI_E2E_NETWORK_LOG']) await assert.rejects(startCli({ unsetEnv: [name] }), /cannot be unset/)
})

test('anthropic redirect: a seeded API key reaches the fake Models and Messages APIs', { timeout: 120_000 }, async () => {
  const cli = await startCli({
    columns: 120, rows: 40,
    model: 'claude-sonnet-4-5-20250929',
    anthropic: { responder: record => record.path === '/v1/messages' && record.body?.tools?.length ? { text: 'HARNESS_ANTHROPIC_REPLY' } : undefined },
    secureStorage: { claudeNative: claudeApiKeyCredential(ANTHROPIC_KEY) },
  })
  try {
    await cli.waitForText('Describe a task', 60_000)
    await cli.submit('HARNESS_ANTHROPIC: say hello.')
    await cli.waitForText('HARNESS_ANTHROPIC_REPLY', 60_000)

    const catalog = cli.anthropic.modelRequests()[0]
    assert.ok(catalog, 'startup must load the Claude catalog from fake-anthropic')
    assert.equal(catalog.headers['x-api-key'], ANTHROPIC_KEY)
    assert.equal(catalog.headers['anthropic-version'], '2023-06-01')
    const main = cli.anthropic.messageRequests().find(record => record.body.tools?.length)
    assert.ok(main, 'the user turn must reach POST /v1/messages')
    assert.equal(main.body.stream, true)
    assert.equal(main.headers['x-api-key'], ANTHROPIC_KEY)
    assert.equal(main.headers.authorization, undefined)
    assert.doesNotMatch(main.headers['anthropic-beta'] ?? '', /oauth/)
    assert.equal(cli.router.requests.length, 0, 'no Verboo router inference for a Claude model')

    // Seeding and decoding: the CLI read the keyring through the fake secret-tool.
    assert.equal(cli.env.PATH.split(':')[0], join(cli.dir, 'fixture-bin'))
    const ops = await cli.keyringOps()
    assert.ok(ops.some(op => op.action === 'lookup'), 'the CLI must have used the fake secret-tool')
    const stored = await cli.readSecureStorage()
    assert.equal(stored.claudeNative?.keyHint ?? Object.values(stored.providerAccounts?.claude?.accounts ?? {})[0]?.credential?.keyHint, 'AAAA')
  } finally { await cli.stop() }
})

test('openai redirect and keyring write: /openai login stores the key, a restarted CLI chats through it', { timeout: 180_000 }, async () => {
  const openai = await createFakeOpenAI({ responder: record => record.path === '/v1/chat/completions' && record.body?.tools?.length ? { text: 'HARNESS_OPENAI_REPLY' } : undefined })
  let first
  try {
    first = await startCli({ columns: 120, rows: 40, slashCommands: true, openai })
    await first.waitForText('Describe a task', 60_000)
    assert.equal(await first.readSecureStorage(), null, 'a fresh fixture starts with an empty keyring')
    await first.submit('/openai login')
    await first.waitForText('Conectar OpenAI', 60_000)
    await first.type(OPENAI_KEY)
    await delay(200)
    await first.press('enter')
    await first.waitForText('Chave da OpenAI conectada', 60_000)
    const validation = openai.modelRequests()[0]
    assert.equal(validation.headers.authorization, `Bearer ${OPENAI_KEY}`)
    const stored = await first.readSecureStorage()
    assert.deepEqual(stored.openaiApiKey, { apiKey: OPENAI_KEY, keyHint: 'BBBB' })
    assert.ok((await first.keyringOps()).some(op => op.action === 'store'))
    await first.stop()

    // Same fixture dir (config + keyring), new process, like a user restarting.
    const second = await startCli({ reuse: first, columns: 120, rows: 40, openai, model: 'openai-api/gpt-5.5' })
    try {
      await second.waitForText('Describe a task', 60_000)
      await second.submit('HARNESS_OPENAI: say hello.')
      await second.waitForText('HARNESS_OPENAI_REPLY', 60_000)
      const chat = openai.chatRequests().find(record => record.body.tools?.length)
      assert.equal(chat.body.model, 'gpt-5.5', 'the openai-api/ prefix must be stripped')
      assert.equal(chat.body.stream, true)
      assert.equal(chat.headers.authorization, `Bearer ${OPENAI_KEY}`)
      assert.notEqual(second.runDir, first.runDir)
    } finally { await second.stop() }
  } finally {
    if (first && !first.exited) await first.stop().catch(() => {})
    await openai.close()
  }
})

test('default layout: without VERBOO_CONFIG_DIR the config, keyring service and sessions live under the temp HOME', { timeout: 120_000 }, async () => {
  const cli = await startCli({
    columns: 120, rows: 40, openai: true,
    unsetEnv: ['VERBOO_CONFIG_DIR', 'VERBOO_PROJECTS_DIR'],
    secureStorage: { openaiApiKey: openaiApiKeyCredential(OPENAI_KEY) },
    routerHandler: async (req, body, res) => {
      if (req.pathname === '/router/v1/chat/completions') return sendChatCompletion(res, body, { text: 'HARNESS_LAYOUT_REPLY' }).then(() => true)
    },
  })
  try {
    assert.equal(cli.config, join(cli.home, '.verboo'))
    assert.equal(cli.env.VERBOO_CONFIG_DIR, undefined)
    assert.equal(cli.env.HOME, cli.home)
    await cli.waitForText('Describe a task', 60_000)
    // The seeded key was found under the un-hashed service name.
    await cli.waitFor(() => cli.openai.modelRequests().some(record => record.headers.authorization === `Bearer ${OPENAI_KEY}`), 60_000)
    assert.ok((await cli.keyringOps()).every(op => op.attributes.service === 'Verboo Code-credentials'))
    await cli.submit('HARNESS_LAYOUT: say hello.')
    await cli.waitForText('HARNESS_LAYOUT_REPLY', 60_000)
    await cli.waitFor(async () => (await readdir(join(cli.home, '.verboo/projects'), { recursive: true }).catch(() => [])).some(file => file.endsWith('.jsonl')), 60_000)
  } finally { await cli.stop() }
})

test('plainTextCredentials and secureStorage reach the real storage code: Copilot tokens are purged, siblings kept', { timeout: 120_000 }, async () => {
  const cli = await startCli({
    columns: 120, rows: 40,
    secureStorage: { fixtureSibling: 'vault-kept', githubModels: githubModelsCredential('fixture-copilot-vault') },
    plainTextCredentials: { fixtureSibling: 'plain-kept', githubModels: githubModelsCredential('fixture-copilot-plain') },
  })
  try {
    await cli.waitForText('Describe a task', 60_000)
    await cli.waitFor(async () => !(await cli.readSecureStorage())?.githubModels && !(await cli.readPlainTextCredentials())?.githubModels, 60_000)
    assert.equal((await cli.readSecureStorage()).fixtureSibling, 'vault-kept')
    assert.equal((await cli.readPlainTextCredentials()).fixtureSibling, 'plain-kept')
    assert.ok((await cli.keyringOps()).some(op => op.action === 'store'))
  } finally { await cli.stop() }
})

test('routerHandler drives the main model and the classifier; userSettings and skipPermissions:false take effect', { timeout: 180_000 }, async () => {
  const classifierRequests = []
  const cli = await startCli({
    columns: 120, rows: 40, skipPermissions: false,
    userSettings: { skipAutoPermissionPrompt: true, permissions: { defaultMode: 'auto' } },
    routerOptions: { models: ['fixture-model', 'fixture-classifier'], agentModelRoles: { classifier: 'fixture-classifier' } },
    routerHandler: async (req, body, res) => {
      if (req.pathname !== '/router/v1/chat/completions') return undefined
      if (isClassifierRequest(body)) {
        classifierRequests.push(body)
        await sendClassifierVerdict(res, body, { reason: 'Fixture allows the marker file' })
        return true
      }
      // Side queries (no tools) keep the default fixture behavior.
      if (!body.tools?.length) return undefined
      await sendChatCompletion(res, body, hasToolResult(body)
        ? { text: 'HARNESS_AUTO_REPLY' }
        // An interpreter call: acceptEdits' fast path would allow a plain touch without asking the classifier.
        : { toolCalls: [{ name: 'Bash', arguments: { command: `node -e "require('fs').writeFileSync('harness-auto.txt','ok')"`, description: 'Create the marker file' } }] })
      return true
    },
  })
  try {
    await cli.waitForText('Describe a task', 60_000)
    await cli.submit('HARNESS_AUTO: create the marker.')
    await cli.waitForText('HARNESS_AUTO_REPLY', 60_000)
    assert.ok(classifierRequests.length >= 1, 'auto mode must have asked the classifier')
    assert.equal(classifierRequests[0].model, 'fixture-classifier', 'the classifier must run on the router role')
    assert.ok(existsSync(join(cli.project, 'harness-auto.txt')), 'the approved command must have run in the project')
    const catalog = cli.router.allRequests.find(record => record.path.endsWith('/models'))
    assert.ok(catalog, 'the router catalog must be requested')
  } finally { await cli.stop() }
})

test('plugins:true loads the Verboo marketplace from the fixture and reaches nothing else', { timeout: 120_000 }, async () => {
  const cli = await startCli({
    columns: 120, rows: 40, plugins: true,
    routerOptions: { agentModelRoles: { classifier: 'fixture-model' } },
    routerHandler: async (req, body, res) => {
      if (req.pathname === '/router/v1/chat/completions') return sendChatCompletion(res, body, { text: 'HARNESS_PLUGINS_REPLY' }).then(() => true)
    },
    args: ['HARNESS_PLUGINS: say hello.'],
  })
  try {
    await cli.waitForText('HARNESS_PLUGINS_REPLY', 60_000)
    await cli.waitFor(() => cli.router.allRequests.some(record => record.path === '/api/plugins/marketplace.json'), 60_000)
    // Give background plugin/marketplace work time to run before checking.
    await delay(5_000)
    const models = cli.router.allRequests.find(record => record.path.endsWith('/models'))
    assert.ok(models, 'the router catalog must be requested')
    assert.deepEqual(await cli.networkLog(), [], 'no in-process request may leave the fixtures')
    const subprocesses = await cli.subprocessNetworkLog()
    assert.deepEqual(subprocesses.filter(line => /^git |^(npm|npx|bun|bunx|pnpm|yarn) (install|i|add|ci|exec|x|dlx)\b/.test(line)), [], `plugin code must not clone or install anything: ${subprocesses.join(', ')}`)
    const known = JSON.parse(await readFile(join(cli.config, 'plugins/known_marketplaces.json'), 'utf8').catch(() => '{}'))
    assert.ok(!('claude-plugins-official' in known), 'the official marketplace must not be installed at startup')
    assert.ok(!existsSync(join(cli.config, 'plugins/marketplaces/claude-plugins-official')))
  } finally { await cli.stop() }
})

test('real-user traffic: with the quiet flags removed nothing leaves the fixtures beyond the two known requests', { timeout: 120_000 }, async () => {
  // Both entries are blocked here. Listing them is not an endorsement: the Anthropic
  // one is an open release finding (main.tsx prefetchOfficialMcpUrls). The point of the
  // allowlist is that any NEW external request fails this test.
  const cli = await startCli({
    columns: 120, rows: 40, plugins: true, unsetEnv: REAL_USER_TRAFFIC_ENV,
    allowedNetwork: [/^GET https:\/\/api\.github\.com\/repos\/verbeux-ai\/code\/releases$/, /^GET https:\/\/api\.anthropic\.com\/mcp-registry\/v0\/servers$/],
    routerHandler: async (req, body, res) => {
      if (req.pathname === '/router/v1/chat/completions') return sendChatCompletion(res, body, { text: 'HARNESS_REAL_USER_REPLY' }).then(() => true)
    },
    args: ['HARNESS_REAL_USER: say hello.'],
  })
  try {
    await cli.waitForText('HARNESS_REAL_USER_REPLY', 60_000)
    await delay(15_000)
    assert.ok(!(await cli.networkLog()).some(line => /storage\.googleapis\.com|claude-plugins-official|\/marketplace/.test(line)), 'no official marketplace or installer traffic')
    assert.ok(!existsSync(join(cli.config, 'plugins/marketplaces/claude-plugins-official')))
  } finally { await cli.stop() }
})

test('allowedNetwork keeps a matching entry from failing stop(); anything else still fails', { timeout: 60_000 }, async () => {
  const record = (cli, line) => writeFile(join(cli.runDir, 'unexpected-network.log'), `${line}\n`, { flag: 'a' })
  const allowed = await startCli({ allowedNetwork: [/^GET https:\/\/allowed\.invalid\//] })
  await record(allowed, 'GET https://allowed.invalid/x')
  assert.deepEqual(await allowed.networkLog(), ['GET https://allowed.invalid/x'], 'allowed entries stay in the log')
  await allowed.stop()
  const other = await startCli({ allowedNetwork: [/^GET https:\/\/allowed\.invalid\//] })
  await record(other, 'GET https://allowed.invalid/x')
  await record(other, 'GET https://other.invalid/y')
  await assert.rejects(other.stop(), error => /other\.invalid/.test(error.message) && !/allowed\.invalid/.test(error.message))
})

test('codexHandler sees every Codex request and passes unhandled ones to the Codex fixture', { timeout: 120_000 }, async () => {
  const seen = []
  const cli = await startCli({
    model: 'gpt-5.5', routerOptions: {},
    codexHandler: (req, body) => { seen.push(`${req.method} ${req.pathname}`); return undefined },
    args: ['--effort', 'high', 'CODEX_E2E_SIMPLE: Say exactly that the Codex transport answered.'],
  })
  try {
    await cli.waitForText('CODEX_E2E_SIMPLE_REPLY', 60_000)
    assert.ok(seen.includes('GET /backend-api/codex/models'))
    assert.ok(seen.includes('POST /backend-api/codex/responses'))
    assert.ok(cli.codexProxy.requests.every(record => !record.handled))
    assert.deepEqual(cli.codexRouter.violations, [])
  } finally { await cli.stop() }
})
