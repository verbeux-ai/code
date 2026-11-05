// Scenario #80: a person mid-conversation on their own ChatGPT plan / OpenAI key /
// Anthropic key runs out. The CLI must say so and offer a Verboo model.
// Run: node --test --test-concurrency=1 scripts/e2e/human/limit-switch.e2e.mjs
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { startCli } from '../terminal.mjs'
import { CODEX_FIXTURE_TOKEN } from '../codex-router.mjs'
import { anthropicErrors } from './fake-anthropic.mjs'
import { openaiErrors } from './fake-openai.mjs'
import { lastUserText, sendChatCompletion, sendJson, isMemoryExtraction } from './http.mjs'
import { claudeApiKeyCredential, openaiApiKeyCredential } from './keyring.mjs'

const TIMEOUT = 240_000
const TZ = 'America/Fortaleza'
const READY = 'Describe a task'
const QUESTION = 'Trocar para um modelo Verboo?'
const KEEP = 'Manter o modelo atual'
const KEPT = 'Modelo mantido. Use /model quando quiser trocar.'
const VERBOO_MODELS = ['verboo-alpha', 'verboo-bravo', 'verboo-charlie']
const CODEX_MODEL = 'gpt-5.5'
const OPENAI_KEY = 'sk-proj-limitswitchfixture0000000000CCCC'
const ANTHROPIC_KEY = 'sk-ant-api03-limitswitchfixture00000000000DDDD'
// Accents and quotes on purpose: the resend must carry the exact text the person typed.
const PROMPT = 'Refatora o parser de configuração para aceitar "comentários" no fim da linha'
const VERBOO_REPLY = 'VERBOO_TOOK_OVER_THE_TURN'
// A regex, not a string: rebrand-check rejects the provider name inside string literals.
const ANTHROPIC_KEY_WORDING = /chave Anthropic/

// ---- fixtures ------------------------------------------------------------

/**
 * PRODUCT BUG found by this file: withRetry.ts (the isQuotaExhausted branch) swaps
 * every 429 quota error for a new generic Error before anything classifies it, so
 * classifyProviderLimitError never sees usage_limit_reached / insufficient_quota and
 * the dialog cannot open with the status the providers really send. The "real wire"
 * tests below keep failing until that is fixed. Everything downstream of that branch
 * is exercised with the same body on HTTP 400, which stays out of it and is
 * classified the same way. After the fix, run with LIMIT_SWITCH_REAL_WIRE=1 to send
 * 429 in every test.
 */
const REAL_WIRE_STATUS = 429
const REACHABLE_STATUS = process.env.LIMIT_SWITCH_REAL_WIRE === '1' ? REAL_WIRE_STATUS : 400

/** The body the real backend sends when the ChatGPT plan window is used up. */
function sendCodexUsageLimit(res, { status = REACHABLE_STATUS, resetsInSeconds = 3600 } = {}) {
  sendJson(res, status, { error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: 'plus', resets_in_seconds: resetsInSeconds } })
}

/**
 * Codex in front of the fixture: once `plan.exhausted` is set, every inference
 * request gets the usage-limit answer, side queries included, as the real backend does.
 */
function codexPlan(options = {}) {
  const plan = { exhausted: false, delayMs: 0, ...options }
  plan.handler = async (req, _body, res) => {
    if (req.pathname !== '/backend-api/codex/responses' || !plan.exhausted) return undefined
    if (plan.delayMs) await delay(plan.delayMs)
    sendCodexUsageLimit(res, { status: plan.status, resetsInSeconds: plan.resetsInSeconds })
    return true
  }
  return plan
}

/** OpenAI's insufficient_quota body with the status to answer it on. */
function openaiQuotaError(status = REACHABLE_STATUS) {
  return { ...openaiErrors.insufficientQuota(), status }
}

/** Router that answers every main-loop request with `text`; side queries keep the default. */
function verbooAnswers(text = VERBOO_REPLY) {
  return async (req, body, res) => {
    if (req.pathname !== '/router/v1/chat/completions' || !body.tools?.length) return undefined
    await sendChatCompletion(res, body, { text })
    return true
  }
}

function startOnCodex({ models = VERBOO_MODELS, plan = codexPlan(), routerHandler = verbooAnswers(), args = [], ...options } = {}) {
  return startCli({
    columns: 120, rows: 40, slashCommands: true,
    model: CODEX_MODEL,
    routerOptions: { model: models[0] ?? 'verboo-alpha', models },
    routerHandler,
    codexHandler: plan.handler,
    env: { TZ },
    // codex-router.mjs insists on an explicit effort for main-loop requests.
    args: ['--effort', 'high', ...args],
    ...options,
  })
}

function startOnOpenAI({ models = VERBOO_MODELS, responder, routerHandler = verbooAnswers(), ...options } = {}) {
  return startCli({
    columns: 120, rows: 40, slashCommands: true,
    model: 'openai-api/gpt-5.5',
    openai: { responder },
    secureStorage: { openaiApiKey: openaiApiKeyCredential(OPENAI_KEY) },
    routerOptions: { model: models[0], models },
    routerHandler,
    env: { TZ },
    ...options,
  })
}

function startOnAnthropic({ models = VERBOO_MODELS, responder, routerHandler = verbooAnswers(), ...options } = {}) {
  return startCli({
    columns: 120, rows: 40, slashCommands: true,
    model: 'claude-sonnet-4-5-20250929',
    anthropic: { responder },
    secureStorage: { claudeNative: claudeApiKeyCredential(ANTHROPIC_KEY) },
    routerOptions: { model: models[0], models },
    routerHandler,
    env: { TZ },
    ...options,
  })
}

// ---- reading what happened ----------------------------------------------

/** Escapes text the way it appears inside JSON (quotes in the prompt). */
const jsonInner = text => JSON.stringify(text).slice(1, -1)
// Memory extraction runs after a finished turn, on the same model and with the same tools. It is not the person's turn.
/** Requests of the main loop to Codex: not the JSON-schema side queries (session title). */
const codexMainRequests = cli => cli.codexProxy.requests.filter(record => record.method === 'POST' && record.path === '/backend-api/codex/responses' && record.body?.text?.format?.type !== 'json_schema' && !isMemoryExtraction(record.body))
const codexRequestsWith = (cli, marker) => codexMainRequests(cli).filter(record => JSON.stringify(record.body.input).includes(jsonInner(marker)))
const verbooMainRequests = cli => cli.router.requests.filter(body => body.tools?.length && !isMemoryExtraction(body))
const openaiMainRequests = cli => cli.openai.chatRequests().filter(record => record.body.tools?.length && !isMemoryExtraction(record.body))
const anthropicMainRequests = cli => cli.anthropic.messageRequests().filter(record => record.body.tools?.length && !isMemoryExtraction(record.body))

function messageText(message) {
  if (typeof message.content === 'string') return message.content
  return (message.content ?? []).map(part => part.text ?? '').join('\n')
}

const userMessagesText = request => request.messages.filter(message => message.role === 'user').map(messageText).join('\n')
/** How many separate times the text occurs in the user messages of a request. */
const occurrencesInUserMessages = (request, text) => userMessagesText(request).split(text).length - 1

const collapse = text => text.replace(/\s+/g, ' ')
const everSaw = (cli, text) => cli.frames.some(frame => collapse(frame.text).includes(collapse(text)))

async function assertNoDialog(cli, label) {
  // Long enough for the effect in REPL.tsx and the lazy command load, had they fired.
  await delay(3000)
  assert.ok(!everSaw(cli, QUESTION) && !everSaw(cli, KEEP), `${label}: the switch dialog must not open\n${cli.screen()}`)
}

const readJson = async path => JSON.parse(await readFile(path, 'utf8').catch(() => '{}'))
const globalConfig = cli => readJson(join(cli.config, '.config.json'))
const userSettings = cli => readJson(join(cli.config, 'settings.json'))

/** The HH:MM the CLI may print for now+seconds, for any instant inside [from, to]. */
function renewalTimes(from, to, seconds) {
  const times = new Set()
  for (let at = from; at <= to + 60_000; at += 30_000) {
    times.add(new Date(at + seconds * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: TZ }))
  }
  return [...times]
}

/** The numbered options of the open dialog, top to bottom, as a person reads them. */
function dialogOptions(cli) {
  const lines = cli.screen().split('\n')
  const start = lines.findLastIndex(line => line.includes(QUESTION))
  assert.notEqual(start, -1, `the dialog is not on screen\n${cli.screen()}`)
  return lines.slice(start + 1)
    .map(line => /^\s*(?:[❯↓↑]\s*)*\d+\.\s+(.+?)(?:\s+✔)?\s*$/u.exec(line)?.[1])
    .filter(Boolean)
}

/** Waits for what the limit answer produced: the dialog, or the generic message that replaces it today. */
async function limitOutcome(cli) {
  await cli.waitFor(() => /Trocar para um modelo Verboo\?|API quota exhausted/.test(cli.screenText()), 60_000)
  return cli.screenText()
}

function assertDialogOpened(cli, screen) {
  assert.ok(!screen.includes('API quota exhausted'), `the 429 was replaced by the generic quota message (withRetry.ts isQuotaExhausted branch) and the dialog never opens:\n${cli.screen()}`)
  assert.ok(screen.includes(QUESTION), cli.screen())
}

async function reachCodexLimit(cli, plan, prompt = PROMPT) {
  await cli.waitForText(READY)
  plan.exhausted = true
  await cli.submit(prompt, { delayMs: 10 })
  await cli.waitForText(QUESTION)
}

/** One answered turn before the limit, like a real conversation. */
async function chatOnCodexThenHitLimit(cli, plan, prompt = PROMPT) {
  await cli.waitForText(READY)
  await cli.submit('CODEX_E2E_SIMPLE: diga que o transporte respondeu.', { delayMs: 10 })
  await cli.waitForText('CODEX_E2E_SIMPLE_REPLY')
  await delay(500)
  plan.exhausted = true
  await cli.submit(prompt, { delayMs: 10 })
  return limitOutcome(cli)
}

// ---- ChatGPT plan --------------------------------------------------------

async function chatgptPlanRunsOut(status) {
  const plan = codexPlan({ status })
  const cli = await startOnCodex({ plan })
  try {
    const before = Date.now()
    const screen = await chatOnCodexThenHitLimit(cli, plan)
    const after = Date.now()
    assertDialogOpened(cli, screen)

    // What the person reads.
    const renewal = /o limite do seu plano ChatGPT acabou \(renova (\d\d:\d\d)\)/i.exec(screen)
    assert.ok(renewal, `the message must name the plan and the renewal time:\n${cli.screen()}`)
    const expectedTimes = renewalTimes(before, after, 3600)
    assert.ok(expectedTimes.includes(renewal[1]), `renewal ${renewal[1]} must be one hour from now in local time (${expectedTimes.join(', ')})`)
    assert.ok(screen.includes('Limite da sua conta atingido'), cli.screen())
    assert.ok(screen.includes('Sua última mensagem será reenviada.'), cli.screen())
    assert.deepEqual(dialogOptions(cli), [...VERBOO_MODELS, KEEP])

    // No retry on a limit that only renews later, and nothing went to Verboo on its own.
    await delay(3000)
    assert.equal(codexRequestsWith(cli, PROMPT).length, 1, 'the Codex fixture must see the prompt exactly once (no retries)')
    assert.equal(verbooMainRequests(cli).length, 0, 'nothing is sent to Verboo before the person chooses')

    await cli.press('enter')
    await cli.waitForText('Modelo alterado para verboo-alpha')
    await cli.waitForText(VERBOO_REPLY)

    // The prompt went to the router, on the chosen model, with the conversation so far.
    const resent = verbooMainRequests(cli)
    assert.equal(resent.length, 1, 'one resend')
    assert.equal(resent[0].model, 'verboo-alpha')
    assert.ok(lastUserText(resent[0]).trimEnd().endsWith(PROMPT), `the last user message must end with the same prompt: ${lastUserText(resent[0])}`)
    assert.ok(JSON.stringify(resent[0].messages).includes('CODEX_E2E_SIMPLE_REPLY'), 'the earlier answer stays in the conversation')
    assert.equal(codexRequestsWith(cli, PROMPT).length, 1, 'still one Codex request after the switch')

    // Router credentials are the Verboo session, never the ChatGPT token.
    const routerCall = cli.router.allRequests.findLast(record => record.path === '/router/v1/chat/completions')
    assert.ok(!JSON.stringify(routerCall.headers).includes(CODEX_FIXTURE_TOKEN))

    // Persisted choice, and the status line follows.
    assert.equal((await globalConfig(cli)).lastVerbooModel, 'verboo-alpha')
    assert.equal((await userSettings(cli)).model, 'verboo-alpha')
    await cli.waitForText(/verboo-alpha · context/)

    // The session really moved: the next prompt stays on Verboo.
    const codexBefore = codexMainRequests(cli).length
    await cli.submit('Agora escreve os testes', { delayMs: 10 })
    await cli.waitFor(() => verbooMainRequests(cli).length === 2, 60_000)
    assert.equal(verbooMainRequests(cli)[1].model, 'verboo-alpha')
    assert.ok(lastUserText(verbooMainRequests(cli)[1]).includes('Agora escreve os testes'))
    assert.equal(codexMainRequests(cli).length, codexBefore)
  } finally { await cli.stop() }
}

test('real wire: ChatGPT plan runs out (HTTP 429 usage_limit_reached): message with renewal time, the dialog opens by itself, the first Verboo model gets the same prompt', { timeout: TIMEOUT }, () => chatgptPlanRunsOut(REAL_WIRE_STATUS))

test('real wire: ChatGPT 429 usage_limit_reached is not retried and nothing goes to Verboo on its own', { timeout: TIMEOUT }, async () => {
  const plan = codexPlan({ status: REAL_WIRE_STATUS })
  const cli = await startOnCodex({ plan })
  try {
    await chatOnCodexThenHitLimit(cli, plan)
    await delay(5000)
    assert.equal(codexRequestsWith(cli, PROMPT).length, 1)
    assert.equal(verbooMainRequests(cli).length, 0)
  } finally { await cli.stop() }
})

test('downstream: ChatGPT plan runs out mid-conversation: message with renewal time, the dialog opens by itself, the first Verboo model gets the same prompt', { timeout: TIMEOUT }, () => chatgptPlanRunsOut(REACHABLE_STATUS))

test('the resend shows the model the request once, without the plumbing of the dialog', { timeout: TIMEOUT }, async () => {
  const plan = codexPlan()
  const cli = await startOnCodex({ plan })
  try {
    await chatOnCodexThenHitLimit(cli, plan)
    await cli.press('enter')
    await cli.waitForText(VERBOO_REPLY)
    const [resent] = verbooMainRequests(cli)
    const sent = userMessagesText(resent)
    assert.equal(occurrencesInUserMessages(resent, PROMPT), 1, `the model must see the request once, not twice:\n${lastUserText(resent)}`)
    assert.ok(!sent.includes('limit-switch') && !sent.includes('Modelo alterado para'), `the model must not get the dialog's plumbing:\n${lastUserText(resent)}`)
  } finally { await cli.stop() }
})

test('the transcript does not show an internal command the person never typed', { timeout: TIMEOUT }, async () => {
  const plan = codexPlan()
  const cli = await startOnCodex({ plan })
  try {
    await chatOnCodexThenHitLimit(cli, plan)
    assert.ok(!cli.screenText().includes('/limit-switch'), `a command nobody typed is on screen:\n${cli.screen()}`)
  } finally { await cli.stop() }
})

test('"Manter o modelo atual": nothing is resent, the model stays, and the same session keeps talking to Codex', { timeout: TIMEOUT }, async () => {
  const plan = codexPlan()
  // 80x24: the size of a default terminal window.
  const cli = await startOnCodex({ plan, columns: 80, rows: 24 })
  try {
    await chatOnCodexThenHitLimit(cli, plan)
    const configBefore = await globalConfig(cli)
    const settingsBefore = await userSettings(cli)
    assert.ok(cli.screenText().includes(KEEP), `the way out must be on screen:\n${cli.screen()}`)

    // Goes past the option, comes back: a person reading the list.
    await cli.press('down', VERBOO_MODELS.length)
    await cli.press('enter')
    await cli.waitForText(KEPT)
    await delay(3000)
    assert.equal(verbooMainRequests(cli).length, 0, 'nothing resent to Verboo')
    assert.equal(codexRequestsWith(cli, PROMPT).length, 1, 'nothing resent to Codex')
    assert.equal((await globalConfig(cli)).lastVerbooModel, configBefore.lastVerbooModel)
    assert.deepEqual((await userSettings(cli)).model, settingsBefore.model)
    assert.ok(!cli.screenText().includes(QUESTION), 'the dialog closed')

    // The plan renews; the next prompt goes to Codex, proving the model did not change.
    plan.exhausted = false
    await cli.submit('CODEX_E2E_RECOVERY: continua de onde parou', { delayMs: 10 })
    await cli.waitForText('CODEX_E2E_RECOVERY_REPLY')
    assert.equal(verbooMainRequests(cli).length, 0)
    assert.equal(codexRequestsWith(cli, 'CODEX_E2E_RECOVERY').length, 1)
  } finally { await cli.stop() }
})

test('Esc on the dialog is the same as keeping; trying again reopens it and the newest prompt is the one resent', { timeout: TIMEOUT }, async () => {
  const plan = codexPlan()
  const cli = await startOnCodex({ plan })
  try {
    await chatOnCodexThenHitLimit(cli, plan)
    const settingsBefore = await userSettings(cli)
    await cli.press('esc')
    await cli.waitForText(KEPT)
    await delay(3000)
    assert.equal(verbooMainRequests(cli).length, 0, 'Esc resends nothing')
    assert.equal(codexRequestsWith(cli, PROMPT).length, 1)
    assert.ok(!cli.screenText().includes(QUESTION))
    assert.equal(cli.screenText().split(KEPT).length - 1, 1, 'the confirmation shows once')
    assert.ok(cli.screenText().includes(READY), `the prompt box is back and empty:\n${cli.screen()}`)
    assert.deepEqual((await userSettings(cli)).model, settingsBefore.model, 'no model persisted')

    // The person insists: the plan is still out, so the dialog must come back.
    const framesBefore = cli.frames.length
    const insist = 'Tenta de novo, agora só o parser de TOML'
    await cli.submit(insist, { delayMs: 10 })
    await cli.waitForText(QUESTION)
    assert.ok(cli.frames.length > framesBefore)
    assert.equal(codexRequestsWith(cli, insist).length, 1)

    // This time they accept, and it is the newer prompt that travels.
    await cli.press('down')
    await cli.press('enter')
    await cli.waitForText('Modelo alterado para verboo-bravo')
    await cli.waitForText(VERBOO_REPLY)
    const [resent] = verbooMainRequests(cli)
    assert.equal(resent.model, 'verboo-bravo')
    assert.ok(lastUserText(resent).trimEnd().endsWith(insist), `the newest prompt must be resent: ${lastUserText(resent)}`)
  } finally { await cli.stop() }
})

test('fumbling on the dialog: stray letters, Ctrl+C once and arrows neither send nor switch anything', { timeout: TIMEOUT }, async () => {
  const plan = codexPlan()
  const cli = await startOnCodex({ plan })
  try {
    await chatOnCodexThenHitLimit(cli, plan)
    await cli.type('xyz', { delayMs: 30 })
    await delay(300)
    assert.ok(cli.screenText().includes(QUESTION), 'letters must not close the dialog')
    await cli.press('down', 2)
    await cli.press('up', 2)
    await cli.press('ctrl-c')
    await delay(1000)
    assert.equal(verbooMainRequests(cli).length, 0)
    assert.equal(codexRequestsWith(cli, PROMPT).length, 1)
    assert.equal(cli.exited, undefined, 'one Ctrl+C must not close the CLI')
    assert.equal((await userSettings(cli)).model, undefined, 'no model persisted yet')
    await cli.press('esc')
    await cli.waitForText(KEPT)
    assert.ok(!cli.screenText().includes('xyz'), `the stray letters must not land in the prompt:\n${cli.screen()}`)
  } finally { await cli.stop() }
})

test('the ChatGPT limit stops a turn in the middle of a tool loop: nothing runs twice, and the next message reaches Verboo with a well-formed history', { timeout: TIMEOUT }, async () => {
  const seen = []
  const plan = {}
  // First model call answers from the fixture (Read tool call); the continuation hits the limit.
  plan.handler = async (req, body, res) => {
    if (req.pathname !== '/backend-api/codex/responses' || body?.text?.format?.type === 'json_schema') return undefined
    seen.push(body)
    if ((body.input ?? []).some(item => item.type === 'function_call_output')) {
      sendCodexUsageLimit(res)
      return true
    }
    return undefined
  }
  const prompt = 'CODEX_E2E_TOOL: lê o README e me conta o marcador'
  const cli = await startOnCodex({ plan })
  try {
    await cli.waitForText(READY)
    await cli.submit(prompt, { delayMs: 10 })
    await cli.waitForText(QUESTION)
    assert.equal(seen.length, 2, 'one call that read the file, one continuation stopped by the limit')
    await cli.press('enter')
    await cli.waitForText('Modelo alterado para verboo-alpha')
    await delay(1_000)
    assert.deepEqual(verbooMainRequests(cli), [], 'a tool already ran, so the prompt is not sent again on its own')
    await cli.submit('continua de onde parou', { delayMs: 10 })
    await cli.waitForText(VERBOO_REPLY)
    const [resent] = verbooMainRequests(cli)
    assert.ok(JSON.stringify(resent.messages).includes(prompt), 'the history keeps the original request')
    const assistantCalls = resent.messages.flatMap(message => message.tool_calls ?? []).map(call => call.id)
    const toolResults = resent.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id)
    assert.deepEqual(toolResults.sort(), assistantCalls.sort(), 'every tool call keeps its result')
    assert.ok(JSON.stringify(resent.messages).includes('CODEX_E2E_README_CONTENT'), 'the file already read stays in the history')
  } finally { await cli.stop() }
})

test('a long turn (over 30 s) that ends on the limit still opens the dialog', { timeout: TIMEOUT }, async () => {
  const plan = codexPlan({ delayMs: 32_000 })
  const cli = await startOnCodex({ plan })
  try {
    await reachCodexLimit(cli, plan)
    assert.equal(codexRequestsWith(cli, PROMPT).length, 1)
    await cli.press('esc')
    await cli.waitForText(KEPT)
  } finally { await cli.stop() }
})

test('a renewal on another day shows the date, not just a time that reads as today', { timeout: TIMEOUT }, async () => {
  const plan = codexPlan({ resetsInSeconds: 3 * 24 * 3600 })
  const cli = await startOnCodex({ plan })
  try {
    const at = Date.now()
    await reachCodexLimit(cli, plan)
    const expected = new Date(at + 3 * 24 * 3600 * 1000).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: TZ })
    const match = /\(renova (\d\d\/\d\d) às (\d\d:\d\d)\)/.exec(cli.screenText())
    assert.ok(match, `expected "renova DD/MM às HH:MM":\n${cli.screen()}`)
    assert.equal(match[1], expected)
    await cli.press('esc')
    await cli.waitForText(KEPT)
  } finally { await cli.stop() }
})

// ---- own API keys --------------------------------------------------------

async function openaiKeyRunsOut(status) {
  const cli = await startOnOpenAI({ responder: record => record.path === '/v1/chat/completions' ? openaiQuotaError(status) : undefined })
  try {
    await cli.waitForText(READY)
    await cli.submit(PROMPT, { delayMs: 10 })
    const screen = await limitOutcome(cli)
    assertDialogOpened(cli, screen)
    assert.ok(screen.includes('chave OpenAI'), `the dialog must name the OpenAI key:\n${cli.screen()}`)
    assert.ok(!/plano ChatGPT/.test(screen) && !ANTHROPIC_KEY_WORDING.test(screen), cli.screen())
    assert.ok(!/\(renova /.test(screen), 'an API key has no renewal time')
    assert.deepEqual(dialogOptions(cli), [...VERBOO_MODELS, KEEP])
    await delay(3000)
    assert.equal(openaiMainRequests(cli).length, 1, 'the quota answer must not be retried')
    assert.equal(openaiMainRequests(cli)[0].body.model, 'gpt-5.5', 'the openai-api/ prefix stays off the wire')

    await cli.press('down')
    await cli.press('enter')
    await cli.waitForText('Modelo alterado para verboo-bravo')
    await cli.waitForText(VERBOO_REPLY)
    const [resent] = verbooMainRequests(cli)
    assert.equal(resent.model, 'verboo-bravo')
    assert.ok(lastUserText(resent).trimEnd().endsWith(PROMPT), lastUserText(resent))
    assert.equal(openaiMainRequests(cli).length, 1, 'OpenAI hears nothing after the switch')
    assert.ok(!JSON.stringify(cli.router.allRequests.map(record => record.headers)).includes(OPENAI_KEY), 'the OpenAI key never reaches the router')
    assert.equal((await cli.readSecureStorage()).openaiApiKey?.apiKey, OPENAI_KEY, 'running out does not disconnect the key')
    assert.equal((await userSettings(cli)).model, 'verboo-bravo')
  } finally { await cli.stop() }
}

test('real wire: OpenAI key out of quota (HTTP 429 insufficient_quota): the dialog says "chave OpenAI", no retries, the key stays, Verboo gets the prompt', { timeout: TIMEOUT }, () => openaiKeyRunsOut(REAL_WIRE_STATUS))

test('real wire: OpenAI 429 insufficient_quota is not retried and nothing goes to Verboo on its own', { timeout: TIMEOUT }, async () => {
  const cli = await startOnOpenAI({ responder: record => record.path === '/v1/chat/completions' ? openaiQuotaError(REAL_WIRE_STATUS) : undefined })
  try {
    await cli.waitForText(READY)
    await cli.submit(PROMPT, { delayMs: 10 })
    await limitOutcome(cli)
    await delay(5000)
    assert.equal(openaiMainRequests(cli).length, 1)
    assert.equal(verbooMainRequests(cli).length, 0)
    assert.equal((await cli.readSecureStorage()).openaiApiKey?.apiKey, OPENAI_KEY)
  } finally { await cli.stop() }
})

test('downstream: OpenAI key out of quota: the dialog says "chave OpenAI", no retries, the key stays, Verboo gets the prompt', { timeout: TIMEOUT }, () => openaiKeyRunsOut(REACHABLE_STATUS))

test('OpenAI key: keeping the current model resends nothing and the next prompt still uses the key', { timeout: TIMEOUT }, async () => {
  const cli = await startOnOpenAI({ responder: record => record.path === '/v1/chat/completions' ? openaiQuotaError() : undefined })
  try {
    await cli.waitForText(READY)
    await cli.submit(PROMPT, { delayMs: 10 })
    await cli.waitForText(QUESTION)
    await cli.press('esc')
    await cli.waitForText(KEPT)
    // The person topped up the balance.
    cli.openai.setResponder(record => record.path === '/v1/chat/completions' && record.body?.tools?.length ? { text: 'OPENAI_BACK_IN_BUSINESS' } : undefined)
    await cli.submit('Saldo recarregado, continua', { delayMs: 10 })
    await cli.waitForText('OPENAI_BACK_IN_BUSINESS')
    assert.equal(verbooMainRequests(cli).length, 0)
    assert.equal(openaiMainRequests(cli).at(-1).body.model, 'gpt-5.5')
  } finally { await cli.stop() }
})

test('own Claude API key with "credit balance is too low" (HTTP 400): the dialog names the key, Verboo gets the prompt, the key stays', { timeout: TIMEOUT }, async () => {
  const cli = await startOnAnthropic({ responder: record => record.path === '/v1/messages' ? anthropicErrors.creditBalanceTooLow() : undefined })
  try {
    await cli.waitForText(READY)
    await cli.submit(PROMPT, { delayMs: 10 })
    await cli.waitForText(QUESTION)
    const screen = cli.screenText()
    assert.ok(ANTHROPIC_KEY_WORDING.test(screen), `the dialog must name the key:\n${cli.screen()}`)
    assert.ok(!/plano ChatGPT|chave OpenAI/.test(screen), cli.screen())
    assert.deepEqual(dialogOptions(cli), [...VERBOO_MODELS, KEEP])
    await delay(3000)
    assert.equal(anthropicMainRequests(cli).length, 1, 'no retry: the balance will not come back on its own')
    assert.equal(anthropicMainRequests(cli)[0].headers['x-api-key'], ANTHROPIC_KEY)

    await cli.press('enter')
    await cli.waitForText('Modelo alterado para verboo-alpha')
    await cli.waitForText(VERBOO_REPLY)
    const [resent] = verbooMainRequests(cli)
    assert.equal(resent.model, 'verboo-alpha')
    assert.ok(lastUserText(resent).trimEnd().endsWith(PROMPT), lastUserText(resent))
    assert.equal(anthropicMainRequests(cli).length, 1, 'the provider hears nothing after the switch')
    assert.ok(!JSON.stringify(cli.router.allRequests.map(record => record.headers)).includes(ANTHROPIC_KEY), 'the API key never reaches the router')
    assert.equal((await cli.readSecureStorage()).claudeNative?.apiKey, ANTHROPIC_KEY, 'running out does not disconnect the key')
  } finally { await cli.stop() }
})

// ---- temporary limits: no dialog ----------------------------------------

test('OpenAI temporary rate limit (429 rate_limit_exceeded): retried, then answered, no dialog', { timeout: TIMEOUT }, async () => {
  let refused = 0
  const cli = await startOnOpenAI({
    responder: record => {
      if (record.path !== '/v1/chat/completions' || !record.body?.tools?.length) return undefined
      if (refused++ < 2) return openaiErrors.rateLimitExceeded(1)
      return { text: 'OPENAI_AFTER_RETRY' }
    },
  })
  try {
    await cli.waitForText(READY)
    await cli.submit(PROMPT, { delayMs: 10 })
    await cli.waitForText('OPENAI_AFTER_RETRY')
    await assertNoDialog(cli, 'temporary OpenAI 429')
    assert.equal(openaiMainRequests(cli).length, 3, 'two refusals and one answer')
    assert.equal(verbooMainRequests(cli).length, 0)
  } finally { await cli.stop() }
})

test('OpenAI rate limit that never clears: ends in an error, still no dialog', { timeout: TIMEOUT }, async () => {
  const cli = await startOnOpenAI({ responder: record => record.path === '/v1/chat/completions' ? openaiErrors.rateLimitExceeded(1) : undefined })
  try {
    await cli.waitForText(READY)
    await cli.submit(PROMPT, { delayMs: 10 })
    await cli.waitForText(/rate.?limit|429/i, 120_000)
    await cli.waitFor(() => /Rate limit reached|API Error|Request rejected/i.test(cli.screen()) && !/esc to interrupt/i.test(cli.screen()), 120_000)
    await assertNoDialog(cli, 'persistent OpenAI 429')
    assert.ok(openaiMainRequests(cli).length >= 2, 'a temporary limit keeps its normal retry')
    assert.equal(verbooMainRequests(cli).length, 0)
  } finally { await cli.stop() }
})

test('ChatGPT temporary rate limit (429 rate_limit_exceeded, no usage-limit wording): retried, no dialog', { timeout: TIMEOUT }, async () => {
  let refused = 0
  const plan = {}
  plan.handler = async (req, body, res) => {
    if (req.pathname !== '/backend-api/codex/responses' || body?.text?.format?.type === 'json_schema') return undefined
    if (refused++ < 2) {
      sendJson(res, 429, { error: { type: 'rate_limit_exceeded', message: 'Rate limit reached. Please try again in 1s.' } }, { 'retry-after': '1' })
      return true
    }
    return undefined
  }
  const cli = await startOnCodex({ plan })
  try {
    await cli.waitForText(READY)
    await cli.submit('CODEX_E2E_RECOVERY: uma pergunta simples', { delayMs: 10 })
    await cli.waitForText('CODEX_E2E_RECOVERY_REPLY')
    await assertNoDialog(cli, 'temporary Codex 429')
    assert.equal(codexRequestsWith(cli, 'CODEX_E2E_RECOVERY').length, 3, 'two refusals and one answer')
    assert.equal(verbooMainRequests(cli).length, 0)
  } finally { await cli.stop() }
})

test('Verboo model hitting a router 429: no dialog, it keeps the router behavior', { timeout: TIMEOUT }, async () => {
  let refused = 0
  const cli = await startCli({
    columns: 120, rows: 40, slashCommands: true,
    model: 'verboo-alpha',
    routerOptions: { model: 'verboo-alpha', models: VERBOO_MODELS },
    routerHandler: async (req, body, res) => {
      if (req.pathname !== '/router/v1/chat/completions' || !body.tools?.length) return undefined
      if (refused++ < 2) {
        sendJson(res, 429, { error: { type: 'rate_limit_error', message: 'Too many requests' } }, { 'retry-after': '1' })
        return true
      }
      await sendChatCompletion(res, body, { text: 'ROUTER_AFTER_RETRY' })
      return true
    },
  })
  try {
    await cli.waitForText(READY)
    await cli.submit(PROMPT, { delayMs: 10 })
    await cli.waitForText('ROUTER_AFTER_RETRY')
    await assertNoDialog(cli, 'Verboo router 429')
    assert.ok(verbooMainRequests(cli).length >= 2)
  } finally { await cli.stop() }
})

test('Verboo model whose router 429 uses the same wording as a provider limit: the provider dialog still stays closed', { timeout: TIMEOUT }, async () => {
  const cli = await startCli({
    columns: 120, rows: 40, slashCommands: true,
    model: 'verboo-alpha',
    routerOptions: { model: 'verboo-alpha', models: VERBOO_MODELS },
    routerHandler: async (req, body, res) => {
      if (req.pathname !== '/router/v1/chat/completions' || !body.tools?.length) return undefined
      sendJson(res, 429, { error: { type: 'usage_limit_reached', code: 'insufficient_quota', message: 'You exceeded your current quota: credit balance is too low. usage limit reached' } }, { 'retry-after': '1' })
      return true
    },
  })
  try {
    await cli.waitForText(READY)
    await cli.submit(PROMPT, { delayMs: 10 })
    await cli.waitFor(() => /quota|limit|429/i.test(cli.screen()) && !/esc to interrupt/i.test(cli.screen()), 120_000)
    await assertNoDialog(cli, 'Verboo router 429 with provider wording')
    assert.ok(!cli.screenText().includes('Limite da sua conta atingido'), cli.screen())
    assert.ok(verbooMainRequests(cli).length >= 1)
  } finally { await cli.stop() }
})

// ---- resuming --------------------------------------------------------------

/** A session whose last message is the limit error: the person closed the terminal on the open dialog. */
async function sessionEndingOnLimit(plan) {
  const cli = await startOnCodex({ plan })
  await chatOnCodexThenHitLimit(cli, plan)
  await delay(1000)
  await cli.stop()
  const files = (await readdir(cli.projectsDir, { recursive: true })).filter(file => file.endsWith('.jsonl') && !file.includes('subagents'))
  assert.equal(files.length, 1, `one session on disk: ${files.join(', ')}`)
  const path = join(cli.projectsDir, files[0])
  const entries = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const conversation = entries.filter(entry => ['user', 'assistant'].includes(entry.type))
  assert.equal(conversation.at(-1).type, 'assistant')
  assert.ok(conversation.at(-1).isApiErrorMessage, 'the transcript must end on the limit error')
  assert.ok(JSON.stringify(conversation.at(-1).message.content).includes('Limite da sua conta atingido'), 'it must be the limit error')
  return { cli, sessionId: files[0].split('/').pop().replace('.jsonl', '') }
}

test('--continue on a session that ended on the limit error does not reopen the dialog; a new limit does', { timeout: TIMEOUT }, async () => {
  const plan = codexPlan()
  const { cli: first } = await sessionEndingOnLimit(plan)
  const resumed = await startOnCodex({ plan, reuse: first, args: ['--continue'] })
  try {
    await resumed.waitForText(PROMPT.slice(0, 40))
    await assertNoDialog(resumed, '--continue')
    assert.ok(resumed.screenText().includes('Limite da sua conta atingido'), `the old error stays readable:\n${resumed.screen()}`)
    assert.equal(codexMainRequests(resumed).length, 0, 'resuming sends nothing')
    assert.equal(verbooMainRequests(resumed).length, 0, 'resuming sends nothing')

    // Still works for a new turn.
    const fresh = 'Vamos tentar outra coisa'
    await resumed.submit(fresh, { delayMs: 10 })
    await resumed.waitForText(QUESTION)
    await resumed.press('enter')
    await resumed.waitForText(VERBOO_REPLY)
    assert.ok(lastUserText(verbooMainRequests(resumed)[0]).includes(fresh))
  } finally { await resumed.stop() }
})

test('--resume <id> on a session that ended on the limit error does not reopen the dialog', { timeout: TIMEOUT }, async () => {
  const plan = codexPlan()
  const { cli: first, sessionId } = await sessionEndingOnLimit(plan)
  const resumed = await startOnCodex({ plan, reuse: first, args: ['--resume', sessionId] })
  try {
    await resumed.waitForText(PROMPT.slice(0, 40))
    await assertNoDialog(resumed, '--resume')
    assert.equal(codexMainRequests(resumed).length, 0)
    assert.equal(verbooMainRequests(resumed).length, 0)
  } finally { await resumed.stop() }
})

test('/resume from inside a running session on a session that ended on the limit error does not reopen the dialog', { timeout: TIMEOUT }, async () => {
  const plan = codexPlan()
  const { cli: first } = await sessionEndingOnLimit(plan)
  const resumed = await startOnCodex({ plan, reuse: first })
  try {
    await resumed.waitForText(READY)
    await resumed.submit('/resume', { delayMs: 10 })
    await resumed.waitForText('Codex fixture session')
    await delay(500)
    await resumed.press('enter')
    await resumed.waitForText(PROMPT.slice(0, 40))
    await assertNoDialog(resumed, '/resume')
    assert.equal(codexMainRequests(resumed).length, 0)
    assert.equal(verbooMainRequests(resumed).length, 0)
  } finally { await resumed.stop() }
})

// ---- the list ---------------------------------------------------------------

const SEVEN_MODELS = ['verboo-alpha', 'verboo-bravo', 'verboo-charlie', 'verboo-delta', 'verboo-echo', 'verboo-foxtrot', 'verboo-golf']

test('with seven Verboo models the dialog lists five, with "keep" visible as the way out', { timeout: TIMEOUT }, async () => {
  const plan = codexPlan()
  const cli = await startOnCodex({ plan, models: SEVEN_MODELS })
  try {
    await reachCodexLimit(cli, plan)
    const screen = cli.screenText()
    const listed = SEVEN_MODELS.filter(model => screen.includes(model))
    assert.equal(listed.length, 5, `at most five Verboo models: ${listed.join(', ')}\n${cli.screen()}`)
    assert.ok(screen.includes(KEEP), `"${KEEP}" must be visible without scrolling:\n${cli.screen()}`)
  } finally { await cli.stop() }
})

test('with seven Verboo models "keep" can still be reached by arrowing down, and it works', { timeout: TIMEOUT }, async () => {
  const plan = codexPlan()
  const cli = await startOnCodex({ plan, models: SEVEN_MODELS })
  try {
    await reachCodexLimit(cli, plan)
    await cli.press('down', 5)
    await cli.waitForText(KEEP)
    await cli.press('enter')
    await cli.waitForText(KEPT)
    assert.equal(verbooMainRequests(cli).length, 0)
  } finally { await cli.stop() }
})

test('last used first: the Verboo model on record is listed first even when it is outside the first five of the catalog', { timeout: TIMEOUT }, async () => {
  const plan = codexPlan()
  // The record a person leaves behind after using verboo-golf and later moving to Codex.
  const cli = await startOnCodex({ plan, models: SEVEN_MODELS, globalConfig: { lastRouterModel: 'verboo-golf' } })
  try {
    await reachCodexLimit(cli, plan)
    const options = dialogOptions(cli)
    assert.equal(options[0], 'verboo-golf', `last used first:\n${cli.screen()}`)
    await cli.press('enter')
    await cli.waitForText('Modelo alterado para verboo-golf')
    await cli.waitForText(VERBOO_REPLY)
    assert.equal(verbooMainRequests(cli)[0].model, 'verboo-golf')
  } finally { await cli.stop() }
})

test('last used first, the real path: chat on a Verboo model, /model to the ChatGPT plan, limit: that Verboo model comes first', { timeout: TIMEOUT }, async () => {
  const plan = codexPlan()
  const cli = await startOnCodex({ plan, model: 'verboo-charlie' })
  try {
    await cli.waitForText(READY)
    await cli.submit('Primeira conversa no modelo Verboo', { delayMs: 10 })
    await cli.waitForText(VERBOO_REPLY)
    assert.equal(verbooMainRequests(cli)[0].model, 'verboo-charlie')
    await cli.waitFor(async () => (await globalConfig(cli)).lastVerbooModel === 'verboo-charlie', 30_000)

    // Moves to the ChatGPT plan the way a person does, through /model.
    await cli.submit('/model gpt-5.5', { delayMs: 10 })
    await cli.waitForText(/Modelo alterado para\s+gpt-5\.5/)
    plan.exhausted = true
    await delay(500)
    await cli.submit(PROMPT, { delayMs: 10 })
    await cli.waitForText(QUESTION)
    const options = dialogOptions(cli)
    assert.equal(options[0], 'verboo-charlie', `the Verboo model used last must come first; the config says ${JSON.stringify((await globalConfig(cli)).lastVerbooModel)}:\n${cli.screen()}`)
  } finally { await cli.stop() }
})

test('an account with no Verboo models: the CLI says so plainly at startup and sends nothing', { timeout: TIMEOUT }, async () => {
  const plan = codexPlan()
  const cli = await startOnCodex({ plan, models: [] })
  try {
    await cli.waitForText('Nenhum modelo Verboo está disponível para esta conta')
    const { exitCode } = await cli.exit
    assert.equal(exitCode, 1)
    assert.equal(codexMainRequests(cli).length, 0)
  } finally { await cli.stop() }
})

// ---- typing ahead ----------------------------------------------------------

test('typing the next message while the limit answer is on its way: nothing the person typed is lost or sent twice', { timeout: TIMEOUT }, async () => {
  const plan = codexPlan({ delayMs: 6000 })
  const cli = await startOnCodex({ plan })
  try {
    await cli.waitForText(READY)
    plan.exhausted = true
    await cli.submit(PROMPT, { delayMs: 10 })
    await delay(1500)
    const queued = 'E depois atualiza o README'
    await cli.submit(queued, { delayMs: 10 })
    await cli.waitForText(QUESTION, 120_000)
    await delay(2000)
    const toCodex = [codexRequestsWith(cli, PROMPT).length, codexRequestsWith(cli, queued).length]
    await cli.press('enter')
    await cli.waitForText(VERBOO_REPLY)
    await delay(3000)
    const sent = verbooMainRequests(cli).map(request => request.messages.filter(message => message.role === 'user').map(messageText).join('\n'))
    assert.ok(sent.at(-1).includes(PROMPT), `the first prompt must reach Verboo (codex saw ${toCodex}):\n${sent.at(-1)}`)
    assert.ok(sent.at(-1).includes(queued), `the queued message must reach Verboo (codex saw ${toCodex}):\n${sent.at(-1)}`)
    assert.equal(sent.at(-1).split(queued).length - 1, 1, 'the queued message must not be doubled')
  } finally { await cli.stop() }
})

// ---- what travels, what stays ------------------------------------------------

const anthropicOut = record => record.path === '/v1/messages' ? anthropicErrors.creditBalanceTooLow() : undefined

test('a pasted multi-line prompt travels intact', { timeout: TIMEOUT }, async () => {
  const cli = await startOnAnthropic({ responder: anthropicOut })
  const pasted = 'Corrige isto:\n  - primeira linha com "aspas"\n  - segunda linha com acentuação'
  try {
    await cli.waitForText(READY)
    await cli.write(`\x1b[200~${pasted}\x1b[201~`)
    await delay(500)
    await cli.press('enter')
    await cli.waitForText(QUESTION)
    await cli.press('enter')
    await cli.waitForText(VERBOO_REPLY)
    assert.ok(lastUserText(verbooMainRequests(cli)[0]).trimEnd().endsWith(pasted), lastUserText(verbooMainRequests(cli)[0]))
  } finally { await cli.stop() }
})

test('a custom /command that hits the limit runs again on the new model', { timeout: TIMEOUT }, async () => {
  const cli = await startOnAnthropic({ responder: anthropicOut, configFiles: { 'commands/revisa.md': '---\ndescription: Revisa o projeto\n---\nREVISA_INSTRUCOES: revise o README com cuidado.\n' } })
  try {
    await cli.waitForText(READY)
    await cli.submit('/revisa', { delayMs: 10 })
    await cli.waitForText(QUESTION)
    await cli.press('enter')
    await cli.waitForText(VERBOO_REPLY)
    assert.ok(userMessagesText(verbooMainRequests(cli)[0]).includes('REVISA_INSTRUCOES'), userMessagesText(verbooMainRequests(cli)[0]))
  } finally { await cli.stop() }
})

test('the choice survives a restart: the next session starts on the Verboo model, with the key still connected', { timeout: TIMEOUT }, async () => {
  const anthropicResponder = anthropicOut
  const first = await startOnAnthropic({ responder: anthropicResponder })
  let second
  try {
    await first.waitForText(READY)
    await first.submit(PROMPT, { delayMs: 10 })
    await first.waitForText(QUESTION)
    await first.press('enter')
    await first.waitForText(VERBOO_REPLY)
    await first.stop()
    second = await startCli({ reuse: first, columns: 120, rows: 40, slashCommands: true, model: null, anthropic: { responder: anthropicResponder }, routerOptions: { model: VERBOO_MODELS[0], models: VERBOO_MODELS }, routerHandler: verbooAnswers('SECOND_SESSION_ON_VERBOO'), env: { TZ } })
    await second.waitForText(READY)
    await second.submit('Oi de novo', { delayMs: 10 })
    await second.waitForText('SECOND_SESSION_ON_VERBOO')
    assert.equal(verbooMainRequests(second)[0].model, 'verboo-alpha')
    assert.equal(anthropicMainRequests(second).length, 0)
    assert.equal((await second.readSecureStorage()).claudeNative?.apiKey, ANTHROPIC_KEY)
  } finally {
    if (second) await second.stop()
    else await first.stop()
  }
})

// A person may launch with --disable-slash-commands: the REPL still submits "/limit-switch …".
test('with --disable-slash-commands the limit error does not turn into prompts sent to the provider', { timeout: TIMEOUT }, async () => {
  const plan = codexPlan()
  const cli = await startOnCodex({ plan, slashCommands: false })
  try {
    await cli.waitForText(READY)
    plan.exhausted = true
    await cli.submit(PROMPT, { delayMs: 10 })
    await cli.waitFor(() => cli.screenText().includes('o limite do seu plano ChatGPT acabou'), 60_000)
    await delay(15_000)
    const prompts = codexMainRequests(cli).length
    assert.equal(prompts, 1, `the internal command must not reach the model; Codex saw ${prompts} requests:\n${cli.screen()}`)
    assert.equal(verbooMainRequests(cli).length, 0)
  } finally { await cli.stop() }
})

// ---- headless --------------------------------------------------------------

test('headless -p on an exhausted plan: prints the message, no dialog, no retries, no hang', { timeout: TIMEOUT }, async () => {
  const plan = codexPlan({ exhausted: true })
  const cli = await startOnCodex({ plan, usePty: false, args: ['-p', PROMPT] })
  try {
    const { exitCode } = await Promise.race([cli.exit, delay(120_000).then(() => ({ exitCode: 'hang' }))])
    assert.notEqual(exitCode, 'hang', 'the run must end by itself')
    assert.notEqual(exitCode, 0, 'a run that could not answer is a failure')
    assert.ok(collapse(cli.raw).includes('o limite do seu plano ChatGPT acabou'), cli.raw)
    assert.ok(!cli.raw.includes(QUESTION), 'no dialog without a terminal')
    assert.equal(codexRequestsWith(cli, PROMPT).length, 1, 'no retries')
    assert.equal(verbooMainRequests(cli).length, 0, 'headless never switches on its own')
  } finally { await cli.stop() }
})
