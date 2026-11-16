// Scenario (#75): a person connects their own provider Console key with /claude.
// They paste or type it, make mistakes, recover, chat with it, restart, log out.
// Every case checks the screen AND the side effects (fake API requests, keyring, files).
//
// Run from the worktree root:
//   node --test --test-concurrency=1 scripts/e2e/human/claude-key.e2e.mjs
//
// The keys are derived at run time from a fixed label, so they are fake, stable,
// and no key-shaped literal sits in the repository.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { REAL_USER_TRAFFIC_ENV, startCli } from '../terminal.mjs'
import { anthropicErrors, createFakeAnthropic, DEFAULT_ANTHROPIC_MODELS } from './fake-anthropic.mjs'
import { lastUserText, sendChatCompletion, sendJson } from './http.mjs'

const KEY_PREFIX = 'sk-ant-api03-'
const fixtureKey = (label, tail) => `${KEY_PREFIX}${createHash('sha512').update(`claude-key-e2e ${label}`).digest('base64url')}${tail}`
const FIRST_KEY = fixtureKey('first', 'Aa-K1st')
const SECOND_KEY = fixtureKey('second', 'Bb-K2nd')
const REVOKED_KEY = fixtureKey('revoked', 'Cc-R0ck')

const SONNET = DEFAULT_ANTHROPIC_MODELS[0].id
const HAIKU = DEFAULT_ANTHROPIC_MODELS[1].id
const CLAUDE_REPLY = 'RESPOSTA_DO_CLAUDE_OK'
const ROUTER_REPLY = 'RESPOSTA_DO_VERBOO_OK'
const IDLE = 'Describe a task'
const PROMPT_TITLE = 'Conectar Claude com sua chave de API'
const CANCELLED = 'Conexão Claude cancelada'
const PICKER_HEADER = 'Modelos disponíveis no Verboo Code'
const REMOVED = /chave da anthropic removida/i
const NOT_CONNECTED = 'Claude não conectado'
const VIA_KEY_ROW = /via.sua.chave.anthropic/i

const MODELS_REQUEST = { path: '/v1/models', method: 'GET' }

// ---- The fake API behaves like the real one: only the keys it knows are valid. ----
const acceptOnly = (...validKeys) => record => {
  if (!validKeys.includes(record.headers['x-api-key'])) return anthropicErrors.unauthorized()
  if (record.path === '/v1/messages' && record.body?.tools?.length) return { text: CLAUDE_REPLY }
  return undefined
}

const routerHandler = async (req, body, res) => {
  if (req.pathname !== '/router/v1/chat/completions' || !body.tools?.length) return undefined
  await sendChatCompletion(res, body, { text: ROUTER_REPLY })
  return true
}

function session(options = {}) {
  return startCli({
    columns: 100, rows: 30, slashCommands: true, model: null,
    anthropic: { responder: acceptOnly(FIRST_KEY, SECOND_KEY) },
    routerHandler,
    ...options,
  })
}

// ---- What the person does ----
const ready = async cli => { await cli.waitForText(IDLE); await delay(200) }
const paste = async (cli, text) => { cli.write(`\x1b[200~${text}\x1b[201~`); await delay(400) }
const runCommand = (cli, command) => cli.submit(command, { settleMs: 500 })

async function openKeyPrompt(cli, command = '/claude') {
  await runCommand(cli, command)
  await cli.waitForText(PROMPT_TITLE)
  await delay(200)
}

async function connectKey(cli, key) {
  await openKeyPrompt(cli)
  await paste(cli, key)
  await cli.press('enter')
  await cli.waitForText(`conectada (…${key.slice(-4)})`)
  await ready(cli)
}

async function pickModel(cli, rowPattern, modelId) {
  await runCommand(cli, '/model')
  await cli.waitForText(PICKER_HEADER)
  for (let attempt = 0; attempt < 12; attempt++) {
    await delay(200)
    const focused = cli.screen().split('\n').find(line => /^\s*❯\s*\d+\./.test(line)) ?? ''
    if (rowPattern.test(focused)) {
      await cli.press('enter')
      await cli.waitForText(`Modelo alterado para ${modelId}`)
      return ready(cli)
    }
    await cli.press('down')
  }
  assert.fail(`No row matching ${rowPattern} in the model picker:\n${cli.screen()}`)
}

// ---- What is checked ----
const stripAnsi = text => text
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1bP[^\x1b]*\x1b\\/g, '')
  .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '')
  .replace(/\x1b./g, '')
const squeeze = text => text.replace(/\s+/g, '')

/** Neither the key nor any 8-character run of its secret part reached the terminal. */
function assertKeyNeverOnTerminal(cli, key) {
  const secret = key.slice(KEY_PREFIX.length)
  const fragments = Array.from({ length: secret.length - 7 }, (_, index) => secret.slice(index, index + 8))
  const views = new Set([squeeze(stripAnsi(cli.raw)), squeeze(cli.screen()), ...cli.frames.map(frame => squeeze(frame.text))])
  for (const view of views) {
    assert.ok(!view.includes(key), 'the full key reached the terminal')
    const leaked = fragments.find(fragment => view.includes(fragment))
    assert.equal(leaked, undefined, 'a run of 8 characters of the key reached the terminal')
  }
}

/** Every file of the fixture holding `needle` in clear (the keyring directory is the vault itself). */
async function filesContaining(root, needle) {
  const found = []
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'keyring' || entry.name === 'fixture-bin') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && (await readFile(path)).includes(needle)) found.push(relative(root, path))
    }
  }
  await walk(root)
  return found
}

const claudeAccounts = stored => Object.values(stored?.providerAccounts?.claude?.accounts ?? {})

async function assertNoClaudeCredential(cli, ...keys) {
  const stored = await cli.readSecureStorage()
  assert.equal(stored?.claudeNative, undefined, 'no credential mirror in the keyring')
  assert.deepEqual(claudeAccounts(stored), [], 'no provider account in the keyring')
  const plain = await cli.readPlainTextCredentials()
  for (const key of keys) {
    assert.ok(!JSON.stringify(plain ?? {}).includes(key), 'the key must not be in .credentials.json')
    assert.deepEqual(await filesContaining(cli.dir, key), [], 'the key must not be in any file in clear')
  }
}

function assertRouterNeverSawKey(cli, ...keys) {
  const everything = JSON.stringify(cli.router.allRequests)
  for (const key of keys) assert.ok(!everything.includes(key), 'the key must never reach the Verboo router')
}

/** Only the key authenticates; nothing of the OAuth or Verboo session goes along. */
function assertKeyOnlyRequest(record, key) {
  const where = `${record.method} ${record.path}`
  assert.equal(record.headers['x-api-key'], key, `${where}: x-api-key`)
  assert.equal(record.headers.authorization, undefined, `${where}: no Authorization header`)
  assert.doesNotMatch(record.headers['anthropic-beta'] ?? '', /oauth/i, `${where}: no OAuth beta`)
  assert.equal(record.headers['x-claude-code-session-id'], undefined, `${where}: no session id header`)
  assert.equal(record.headers['x-app'], undefined, `${where}: no x-app header`)
  assert.ok(record.headers['user-agent'], `${where}: a User-Agent`)
}

const mainRequestWith = (fake, text) => fake.messageRequests().find(record => record.body?.tools?.length && JSON.stringify(record.body.messages).includes(JSON.stringify(text)))

// ---- 1. Opening the prompt ----

test('/claude with no arguments opens the key prompt and contacts nobody', { timeout: 240_000 }, async () => {
  const cli = await session()
  try {
    await cli.waitForText(IDLE)
    await cli.type('/claude', { delayMs: 40 })
    await cli.waitForText('Conectar sua chave de API')
    await delay(300)
    await cli.press('enter')
    await cli.waitForText(PROMPT_TITLE)
    const screen = cli.screenText()
    assert.match(screen, /Cole uma chave de API da anthropic/i)
    assert.match(screen, /console\.anthropic\.com/)
    assert.match(screen, /Chave:/)
    assert.match(screen, /Enter para confirmar · Esc para cancelar/)

    assert.deepEqual(cli.anthropic.requests, [], 'opening the prompt calls no API')
    assert.deepEqual(await cli.browserOpens(), [], 'the retired OAuth flow opens no browser')
    assert.ok(!(await cli.keyringOps()).some(op => op.action === 'store'), 'nothing is written to the keyring')
    await assertNoClaudeCredential(cli)

    await cli.press('esc')
    await cli.waitForText(CANCELLED)
    await ready(cli)
    // The explicit form opens the same prompt.
    await openKeyPrompt(cli, '/claude login')
    assert.match(cli.screenText(), /Chave:/)
  } finally { await cli.stop() }
})

// ---- 2. A value that is not a key ----

test('typing a non-key is refused locally: no request, nothing stored, and the person can fix it', { timeout: 240_000 }, async () => {
  const cli = await session()
  try {
    await cli.waitForText(IDLE)
    await openKeyPrompt(cli)
    await cli.type('minha-senha', { delayMs: 25 })
    await delay(300)
    await cli.press('enter')
    await cli.waitForText('não parece uma chave')
    assert.match(cli.screenText(), /começa com sk-ant-/)
    assert.match(cli.screenText(), /Chave:/, 'the prompt stays open')
    assert.deepEqual(cli.anthropic.requests, [], 'a non-key never goes to the API')
    await assertNoClaudeCredential(cli)
    assert.ok(!squeeze(stripAnsi(cli.raw)).includes('minha-senha'), 'the mistyped secret is masked too')

    // Recovery: erases what was typed, then pastes the real key.
    await cli.press('backspace', 'minha-senha'.length)
    await delay(300)
    await paste(cli, FIRST_KEY)
    await cli.press('enter')
    await cli.waitForText(`conectada (…${FIRST_KEY.slice(-4)})`)
    assert.equal(cli.anthropic.modelRequests()[0].headers['x-api-key'], FIRST_KEY)
    assert.equal(claudeAccounts(await cli.readSecureStorage()).length, 1)
  } finally { await cli.stop() }
})

test('after a non-key is refused, pasting the real key right away connects it', { timeout: 240_000 }, async () => {
  const cli = await session()
  try {
    await cli.waitForText(IDLE)
    await openKeyPrompt(cli)
    await cli.type('minha-senha', { delayMs: 25 })
    await delay(300)
    await cli.press('enter')
    await cli.waitForText('não parece uma chave')
    // The masked field gives no hint that the refused text is still in it.
    await paste(cli, FIRST_KEY)
    await cli.press('enter')
    await cli.waitForText(`conectada (…${FIRST_KEY.slice(-4)})`, 15_000)
  } finally { await cli.stop() }
})

// ---- 3. A well-formed key the API refuses ----

test('a well-formed key refused by the API (401) shows the error and stores nothing', { timeout: 240_000 }, async () => {
  const cli = await session()
  try {
    await cli.waitForText(IDLE)
    await openKeyPrompt(cli)
    await paste(cli, REVOKED_KEY)
    await cli.press('enter')
    await cli.waitForText('recusou essa chave')
    assert.match(cli.screenText(), /Confira a chave no Console/)
    assert.match(cli.screenText(), /Chave:/, 'the prompt stays open')

    const [validation, ...others] = cli.anthropic.requests
    assert.equal(others.length, 0, 'one validation request and nothing else')
    assert.equal(`${validation.method} ${validation.path}`, 'GET /v1/models')
    assertKeyOnlyRequest(validation, REVOKED_KEY)
    await assertNoClaudeCredential(cli, REVOKED_KEY)
    assertKeyNeverOnTerminal(cli, REVOKED_KEY)

    // Gives up: Claude stays unconnected and /model offers no Claude row.
    await cli.press('esc')
    await cli.waitForText(CANCELLED)
    await ready(cli)
    await runCommand(cli, '/claude status')
    await cli.waitForText(NOT_CONNECTED)
    await ready(cli)
    await runCommand(cli, '/model')
    await cli.waitForText(PICKER_HEADER)
    await delay(300)
    assert.doesNotMatch(cli.screenText(), VIA_KEY_ROW)
    await cli.press('esc')
  } finally { await cli.stop() }
})

test('after a key is refused (401), pasting the corrected key validates that key, not both glued together', { timeout: 240_000 }, async () => {
  const cli = await session()
  try {
    await cli.waitForText(IDLE)
    await openKeyPrompt(cli)
    await paste(cli, REVOKED_KEY)
    await cli.press('enter')
    await cli.waitForText('recusou essa chave')
    await delay(300)
    await paste(cli, FIRST_KEY)
    await cli.press('enter')
    await cli.waitFor(() => cli.anthropic.modelRequests().length >= 2, 30_000)
    const sent = cli.anthropic.modelRequests()[1].headers['x-api-key']
    assert.ok(sent === FIRST_KEY, `the second validation must carry the pasted key; it carried ${sent.length} characters (the pasted key has ${FIRST_KEY.length})`)
    await cli.waitForText(`conectada (…${FIRST_KEY.slice(-4)})`, 15_000)
  } finally { await cli.stop() }
})

test('when the API is unavailable the error says so, nothing is stored, and Enter retries', { timeout: 240_000 }, async () => {
  const cli = await session()
  try {
    await cli.waitForText(IDLE)
    cli.anthropic.enqueue(anthropicErrors.overloaded(), MODELS_REQUEST)
    await openKeyPrompt(cli)
    await paste(cli, FIRST_KEY)
    await cli.press('enter')
    await cli.waitForText('Não foi possível validar a chave')
    assert.doesNotMatch(cli.screenText(), /recusou/, 'an outage is not a refused key')
    await assertNoClaudeCredential(cli, FIRST_KEY)
    assertKeyNeverOnTerminal(cli, FIRST_KEY)

    await cli.press('enter')
    await cli.waitForText(`conectada (…${FIRST_KEY.slice(-4)})`)
    assert.equal(claudeAccounts(await cli.readSecureStorage()).length, 1)
  } finally { await cli.stop() }
})

// ---- 4. Masking ----

test('the key is masked while typing: at most its 6 edge characters on screen, never the key, before or after', { timeout: 240_000 }, async () => {
  const cli = await session({ columns: 80, rows: 24 })
  try {
    await cli.waitForText(IDLE)
    await openKeyPrompt(cli)
    const firstFrame = cli.frames.length
    await cli.type(FIRST_KEY, { delayMs: 15 })
    await delay(400)
    assert.match(cli.screenText(), /Chave: sk-\*+/, 'the person sees the mask')
    assert.ok(cli.screenText().includes(FIRST_KEY.slice(-3)), 'the last characters help to recognize the key')
    assert.ok(!cli.screenText().includes(FIRST_KEY.slice(-4)), 'no more than the last 3 are shown while typing')

    const typing = cli.frames.slice(firstFrame)
    assert.ok(typing.length > 5, 'typing must have produced frames')
    for (const frame of typing) {
      const field = /Chave:([^\n]*(?:\n {7}[^\n]*)*)/.exec(frame.text)?.[1] ?? ''
      const clearCharacters = field.replace(/[\s*]/g, '')
      assert.ok(clearCharacters.length <= 6, `at most 6 clear characters per frame, saw ${clearCharacters.length}`)
    }
    assertKeyNeverOnTerminal(cli, FIRST_KEY)

    await cli.press('enter')
    await cli.waitForText(`conectada (…${FIRST_KEY.slice(-4)})`)
    await ready(cli)
    await runCommand(cli, '/claude status')
    await cli.waitForText('Chave em uso')
    assertKeyNeverOnTerminal(cli, FIRST_KEY)
    assert.deepEqual(await filesContaining(cli.dir, FIRST_KEY), [], 'the key is in no file in clear')
  } finally { await cli.stop() }
})

test('a pasted key shows only its edges, also when the copied text brings a trailing line break', { timeout: 240_000 }, async () => {
  const cli = await session()
  try {
    await cli.waitForText(IDLE)
    await openKeyPrompt(cli)
    await paste(cli, `${FIRST_KEY}\n`)
    assert.match(cli.screenText(), /Chave: sk-\*+/)
    assertKeyNeverOnTerminal(cli, FIRST_KEY)
    await cli.press('enter')
    await cli.waitForText(`conectada (…${FIRST_KEY.slice(-4)})`)
    assert.equal(cli.anthropic.modelRequests()[0].headers['x-api-key'], FIRST_KEY, 'the line break is not part of the key')
    assert.equal(claudeAccounts(await cli.readSecureStorage())[0].credential.apiKey, FIRST_KEY)
    assertKeyNeverOnTerminal(cli, FIRST_KEY)
  } finally { await cli.stop() }
})

// ---- 5. A valid key ----

test('a valid key connects: model count on screen, api-key credential in the keyring, nothing in clear on disk', { timeout: 240_000 }, async () => {
  const cli = await session({ anthropic: { pageSize: 1, responder: acceptOnly(FIRST_KEY) } })
  try {
    await cli.waitForText(IDLE)
    assert.equal(await cli.readSecureStorage(), null, 'a fresh profile has no credential')
    await openKeyPrompt(cli)
    await paste(cli, FIRST_KEY)
    await cli.press('enter')
    await cli.waitForText(`conectada (…${FIRST_KEY.slice(-4)})`)
    await ready(cli)
    const screen = cli.screenText()
    assert.match(screen, /chave da anthropic conectada/i)
    assert.match(screen, /2 modelo\(s\) Claude liberado\(s\)/, 'every page of the catalog is counted')
    assert.match(screen, /Use \/model para escolher/)
    assert.doesNotMatch(screen, /Conectar Claude com sua chave/, 'the prompt closed')

    // Validation: the Models API with the key, and no inference billed for it.
    const models = cli.anthropic.modelRequests()
    // Both pages for the candidate key, then again for the catalog of the key in use.
    assert.equal(models.length, 4, 'both pages were fetched')
    assert.equal(models[1].query.after_id, SONNET)
    for (const record of models) assertKeyOnlyRequest(record, FIRST_KEY)
    assert.equal(cli.anthropic.messageRequests().length, 0, 'validating spends nothing')

    // Keyring: an api-key credential, with no OAuth material.
    const stored = await cli.readSecureStorage()
    const [account, ...more] = claudeAccounts(stored)
    assert.equal(more.length, 0)
    assert.equal(account.connectionState, 'connected')
    assert.equal(account.displayLabel, 'Claude 1')
    assert.equal(account.credential.authType, 'api-key')
    assert.equal(account.credential.apiKey, FIRST_KEY)
    assert.equal(account.credential.keyHint, FIRST_KEY.slice(-4))
    assert.equal(stored.providerAccounts.claude.defaultAccountId, account.localAccountId)
    assert.deepEqual(stored.claudeNative, account.credential)
    for (const field of ['accessToken', 'refreshToken', 'scopes']) assert.equal(account.credential[field], undefined, `no ${field}`)

    // The secret goes to secret-tool over stdin, never as an argument.
    assert.ok((await cli.keyringOps()).some(op => op.action === 'store'))
    assert.ok(!JSON.stringify(await cli.keyringOps()).includes(FIRST_KEY), 'the key is not in the secret-tool arguments')

    // Disk: no plain-text fallback, no key in config, sessions, history or logs.
    const plain = await cli.readPlainTextCredentials()
    assert.ok(!JSON.stringify(plain ?? {}).includes(FIRST_KEY), '.credentials.json must not hold the key')
    assert.deepEqual(await filesContaining(cli.dir, FIRST_KEY), [], 'the key is in no file in clear')
    assertKeyNeverOnTerminal(cli, FIRST_KEY)
    assertRouterNeverSawKey(cli, FIRST_KEY)
  } finally { await cli.stop() }
})

test('with the keyring unavailable the key is refused with a clear message and never falls back to a file', { timeout: 240_000 }, async () => {
  const cli = await session({ secureStorageError: true })
  try {
    await cli.waitForText(IDLE)
    await openKeyPrompt(cli)
    await paste(cli, FIRST_KEY)
    await cli.press('enter')
    await cli.waitForText(/armazenamento seguro|provider_storage|secure_storage/i)
    await delay(300)
    const screen = cli.screenText()
    assert.doesNotMatch(screen, /conectada \(…/, 'it must not claim success')
    assert.deepEqual(await filesContaining(cli.dir, FIRST_KEY), [], 'no plain-text fallback')
    assert.doesNotMatch(screen, /provider_storage|secure_storage/, 'a person must read a sentence, not an internal error code')
  } finally { await cli.stop() }
})

// ---- 6. /model ----

test('/model lists the Claude models with "via sua chave" and leaving keeps the current model', { timeout: 240_000 }, async () => {
  const cli = await session()
  try {
    await cli.waitForText(IDLE)
    await connectKey(cli, FIRST_KEY)
    await runCommand(cli, '/model')
    await cli.waitForText(PICKER_HEADER)
    await delay(300)
    const rows = cli.screen().split('\n')
    const rowOf = pattern => rows.find(line => pattern.test(line)) ?? ''
    assert.match(rowOf(/\d\.\s+.*fixture-model/), /1\./, 'the Verboo model comes first')
    assert.doesNotMatch(rowOf(/1\. fixture-model/), VIA_KEY_ROW)
    assert.match(rowOf(/Claude Sonnet 4\.5/), VIA_KEY_ROW)
    assert.match(rowOf(/Claude Haiku 4\.5/), VIA_KEY_ROW)

    await cli.press('esc')
    await cli.waitForText('Modelo mantido')
    await ready(cli)
    assert.match(cli.screenText(), /Verboo fixture-model/, 'the footer still shows the Verboo model')
    assert.equal(cli.anthropic.messageRequests().length, 0)
  } finally { await cli.stop() }
})

// Known issue in the terminal renderer, unchanged since 0.15.41: after the autocomplete list closes, cells it
// believes blank still hold old letters ("200K contextc· via sua chavesAnthropic").
test('the /model picker is legible: no leftover characters from the autocomplete list', { timeout: 240_000, todo: 'renderer leaves stale cells' }, async () => {
  // Without the harness override, like a real user.
  const cli = await session({ unsetEnv: ['CLAUDE_CODE_NO_FLICKER'] })
  try {
    await cli.waitForText(IDLE)
    await connectKey(cli, FIRST_KEY)
    await runCommand(cli, '/model')
    await cli.waitForText(PICKER_HEADER)
    await delay(500)
    const rows = cli.screen().split('\n').map(line => line.trimEnd())
    const rowOf = pattern => rows.find(line => pattern.test(line)) ?? ''
    assert.match(rowOf(/Claude Sonnet 4\.5/), /Claude Sonnet 4\.5\s+200K context · via sua chave anthropic$/i)
    assert.match(rowOf(/Claude Haiku 4\.5/), /Claude Haiku 4\.5\s+200K context · via sua chave anthropic$/i)
    assert.match(rowOf(/Modelos disponíveis/), /Modelos disponíveis no Verboo Code$/)
    await cli.press('esc')
  } finally { await cli.stop() }
})

// ---- 7. Chatting with the key ----

test('selecting a Claude model and sending "oi" reaches the API with the key only, and the reply renders', { timeout: 300_000 }, async () => {
  const cli = await session()
  try {
    await cli.waitForText(IDLE)
    await connectKey(cli, FIRST_KEY)
    await pickModel(cli, /Claude Sonnet 4\.5/, SONNET)
    assert.match(cli.screenText(), new RegExp(`Claude ${SONNET}`), 'the footer shows the Claude model')

    await cli.submit('oi')
    await cli.waitForText(CLAUDE_REPLY)
    await delay(500)

    const main = mainRequestWith(cli.anthropic, 'oi')
    assert.ok(main, 'the turn must reach POST /v1/messages')
    assert.equal(main.body.model, SONNET)
    assert.equal(main.body.stream, true)
    for (const record of cli.anthropic.requests) assertKeyOnlyRequest(record, FIRST_KEY)

    assert.equal(cli.router.requests.length, 0, 'no Verboo inference for a Claude model')
    assertRouterNeverSawKey(cli, FIRST_KEY)
    assertKeyNeverOnTerminal(cli, FIRST_KEY)
    assert.deepEqual(await filesContaining(cli.dir, FIRST_KEY), [], 'the key is in no file in clear, including the session transcript')
  } finally { await cli.stop() }
})

test('a request on the key does not present itself as another product nor carry Verboo identifiers', { timeout: 300_000 }, async () => {
  const cli = await session()
  try {
    await cli.waitForText(IDLE)
    await connectKey(cli, FIRST_KEY)
    await pickModel(cli, /Claude Sonnet 4\.5/, SONNET)
    await cli.submit('oi')
    await cli.waitForText(CLAUDE_REPLY)
    await delay(500)

    const main = mainRequestWith(cli.anthropic, 'oi')
    assert.ok(main, 'the turn must reach POST /v1/messages')
    const problems = []
    const userAgent = main.headers['user-agent'] ?? ''
    if (/claude/i.test(userAgent)) problems.push(`user-agent = ${userAgent}`)
    const betas = main.headers['anthropic-beta'] ?? ''
    if (/claude-code/i.test(betas)) problems.push(`anthropic-beta has ${betas.split(',').find(beta => /claude-code/i.test(beta))}`)
    const attribution = (main.body.system ?? []).map(block => block.text ?? '').find(text => /billing-header|cc_version/.test(text))
    if (attribution) problems.push(`system block = ${attribution}`)
    let metadata = {}
    try { metadata = JSON.parse(main.body.metadata?.user_id ?? '{}') } catch { /* not JSON: nothing to read */ }
    for (const field of ['account_uuid', 'session_id', 'device_id']) if (metadata[field]) problems.push(`metadata.user_id.${field} is sent`)
    assert.deepEqual(problems, [])
  } finally { await cli.stop() }
})

// ---- 8. /claude status ----

test('/claude status shows only the last 4 characters of the key', { timeout: 240_000 }, async () => {
  const cli = await session()
  try {
    await cli.waitForText(IDLE)
    await runCommand(cli, '/claude status')
    await cli.waitForText(NOT_CONNECTED)
    assert.match(cli.screenText(), /\/claude login/)
    await ready(cli)

    await connectKey(cli, FIRST_KEY)
    await runCommand(cli, '/claude status')
    await cli.waitForText('Chave em uso')
    await delay(300)
    const screen = cli.screenText()
    assert.match(cli.screenText(), /Claude conectado\. Chave em uso: …/)
    assert.ok(screen.includes(`Chave em uso: …${FIRST_KEY.slice(-4)}.`), 'the hint is the last 4 characters')
    assert.ok(!squeeze(screen).includes(FIRST_KEY.slice(-5)), 'not a fifth character')
    assertKeyNeverOnTerminal(cli, FIRST_KEY)
  } finally { await cli.stop() }
})

// ---- 9. /claude logout ----

test('/claude logout removes the credential and the next message goes to the Verboo router', { timeout: 300_000 }, async () => {
  const cli = await session()
  try {
    await cli.waitForText(IDLE)
    await connectKey(cli, FIRST_KEY)
    await pickModel(cli, /Claude Sonnet 4\.5/, SONNET)
    await cli.submit('oi')
    await cli.waitForText(CLAUDE_REPLY)
    await delay(500)
    await ready(cli)

    await runCommand(cli, '/claude logout')
    await cli.waitForText(REMOVED)
    await ready(cli)
    assert.match(cli.screenText(), /O Verboo continua disponível/)
    assert.match(cli.screenText(), /Verboo fixture-model/, 'the footer is back on the Verboo model')
    await assertNoClaudeCredential(cli, FIRST_KEY)

    const claudeTurns = cli.anthropic.messageRequests().length
    await cli.submit('depois do logout')
    await cli.waitForText(ROUTER_REPLY)
    const turn = cli.router.requests.find(body => lastUserText(body).includes('depois do logout'))
    assert.ok(turn, 'the turn must reach the Verboo router')
    assert.equal(turn.model, 'fixture-model')
    assert.equal(cli.anthropic.messageRequests().length, claudeTurns, 'nothing else on the removed key')
    assertRouterNeverSawKey(cli, FIRST_KEY)

    await ready(cli)
    await runCommand(cli, '/claude status')
    await cli.waitForText(NOT_CONNECTED)
    await ready(cli)
    await runCommand(cli, '/model')
    await cli.waitForText(PICKER_HEADER)
    await delay(300)
    assert.doesNotMatch(cli.screenText(), VIA_KEY_ROW, 'the Claude rows are gone')
    assert.doesNotMatch(cli.screenText(), /Claude Sonnet 4\.5/)
    await cli.press('esc')
  } finally { await cli.stop() }
})

test('after logout a restart stays on Verboo: the key is not read, the catalog is not fetched', { timeout: 300_000 }, async () => {
  const anthropic = await createFakeAnthropic({ responder: acceptOnly(FIRST_KEY) })
  let first
  try {
    first = await session({ anthropic })
    await first.waitForText(IDLE)
    await connectKey(first, FIRST_KEY)
    await pickModel(first, /Claude Sonnet 4\.5/, SONNET)
    await runCommand(first, '/claude logout')
    await first.waitForText(REMOVED)
    await ready(first)
    await first.stop()

    const requestsBefore = anthropic.requests.length
    const second = await session({ anthropic, reuse: first })
    try {
      await second.waitForText(IDLE)
      await delay(1500)
      assert.match(second.screenText(), /Verboo fixture-model/, 'the removed key cannot leave the session on a Claude model')
      await second.submit('oi de novo')
      await second.waitForText(ROUTER_REPLY)
      assert.ok(second.router.requests.some(body => lastUserText(body).includes('oi de novo')))
      assert.equal(anthropic.requests.length, requestsBefore, 'nothing goes to the API without a key')
    } finally { await second.stop() }
  } finally {
    if (first && !first.exited) await first.stop().catch(() => {})
    await anthropic.close()
  }
})

test('/claude logout with nothing connected changes nothing and does not claim to have removed a key', { timeout: 240_000 }, async () => {
  const cli = await session()
  try {
    await cli.waitForText(IDLE)
    await runCommand(cli, '/claude logout')
    await cli.waitFor(() => /\/claude logout\s+└/.test(cli.screen()), 60_000)
    await delay(300)
    await assertNoClaudeCredential(cli)
    assert.match(cli.screenText(), /Verboo fixture-model/)
    assert.doesNotMatch(cli.screenText(), REMOVED, 'no key existed, so none was removed')
  } finally { await cli.stop() }
})

// ---- 10. Cancelling ----

test('Esc cancels the prompt cleanly: half-typed key discarded, nothing stored, the session goes on', { timeout: 240_000 }, async () => {
  const half = FIRST_KEY.slice(0, 40)
  const cli = await session()
  try {
    await cli.waitForText(IDLE)
    await openKeyPrompt(cli)
    await cli.type(half, { delayMs: 10 })
    await delay(300)
    await cli.press('esc')
    await cli.waitForText(CANCELLED)
    await ready(cli)
    assert.match(cli.screenText(), /O Verboo continua disponível/)
    assert.doesNotMatch(cli.screenText(), /Conectar Claude com sua chave/, 'the prompt closed')
    assert.deepEqual(cli.anthropic.requests, [], 'cancelling validates nothing')
    await assertNoClaudeCredential(cli, half)
    assert.ok(!squeeze(stripAnsi(cli.raw)).includes(half), 'the half key never reached the terminal')

    // The half key did not fall into the chat box: the next message is only what is typed.
    await cli.submit('segue o jogo')
    await cli.waitForText(ROUTER_REPLY)
    const turn = cli.router.requests.find(body => lastUserText(body).includes('segue o jogo'))
    assert.ok(turn)
    assert.ok(!lastUserText(turn).includes(half.slice(KEY_PREFIX.length)), 'no piece of the key in the message')
    assert.deepEqual(cli.anthropic.requests, [])
  } finally { await cli.stop() }
})

test('Ctrl+C at the prompt cancels it without closing the CLI', { timeout: 240_000 }, async () => {
  const cli = await session()
  try {
    await cli.waitForText(IDLE)
    await openKeyPrompt(cli)
    await cli.type('sk-ant-engano', { delayMs: 15 })
    await delay(300)
    await cli.press('ctrl-c')
    await cli.waitForText(CANCELLED)
    await ready(cli)
    assert.equal(cli.exited, undefined, 'the CLI keeps running')
    await assertNoClaudeCredential(cli)
    await cli.submit('ainda aqui')
    await cli.waitForText(ROUTER_REPLY)
  } finally { await cli.stop() }
})

test('Esc while the key is being validated really cancels: the late answer stores nothing', { timeout: 240_000 }, async () => {
  const cli = await session()
  try {
    await cli.waitForText(IDLE)
    cli.anthropic.enqueue({
      handle: async res => {
        await delay(3000)
        sendJson(res, 200, { data: DEFAULT_ANTHROPIC_MODELS, has_more: false, first_id: SONNET, last_id: HAIKU })
      },
    }, MODELS_REQUEST)
    await openKeyPrompt(cli)
    await paste(cli, FIRST_KEY)
    await cli.press('enter')
    await cli.waitForText('Validando a chave')
    await cli.press('esc')
    await cli.waitForText(CANCELLED)
    await ready(cli)
    await delay(4500)
    await assertNoClaudeCredential(cli, FIRST_KEY)
    assert.doesNotMatch(cli.screenText(), /conectada \(…/, 'no success message after the cancellation')
    await runCommand(cli, '/claude status')
    await cli.waitForText(/Claude n.o conectado|Chave em uso/)
    assert.match(cli.screenText(), new RegExp(NOT_CONNECTED))
  } finally { await cli.stop() }
})

// ---- 11. A second key ----

test('a second, different key replaces the first: one key at a time, and /claude status names it', { timeout: 300_000 }, async () => {
  const cli = await session()
  try {
    await cli.waitForText(IDLE)
    await connectKey(cli, FIRST_KEY)
    // This time typed in one burst, as a terminal without bracketed paste delivers it.
    await openKeyPrompt(cli)
    cli.write(SECOND_KEY)
    await delay(400)
    await cli.press('enter')
    await cli.waitForText(`conectada (…${SECOND_KEY.slice(-4)})`)
    await ready(cli)

    const accounts = claudeAccounts(await cli.readSecureStorage())
    assert.equal(accounts.length, 1, 'the new key replaces the old one')
    assert.equal(accounts[0].credential.keyHint, SECOND_KEY.slice(-4))
    assert.deepEqual(await filesContaining(cli.dir, FIRST_KEY), [], 'the old key is in no file in clear')
    assert.deepEqual(await filesContaining(cli.dir, SECOND_KEY), [], 'the new key is in no file in clear')

    await runCommand(cli, '/claude status')
    await cli.waitForText(`Chave em uso: …${SECOND_KEY.slice(-4)}`)
    assertKeyNeverOnTerminal(cli, FIRST_KEY)
    assertKeyNeverOnTerminal(cli, SECOND_KEY)

    // What status says is what goes on the wire.
    await ready(cli)
    await pickModel(cli, /Claude Sonnet 4\.5/, SONNET)
    await cli.submit('oi')
    await cli.waitForText(CLAUDE_REPLY)
    const main = mainRequestWith(cli.anthropic, 'oi')
    assert.ok(main)
    assert.equal(main.headers['x-api-key'], SECOND_KEY, 'the key on the wire is the one /claude status names')
  } finally { await cli.stop() }
})

test('/claude logout removes the key and the session goes back to Verboo', { timeout: 300_000 }, async () => {
  const cli = await session()
  try {
    await cli.waitForText(IDLE)
    await connectKey(cli, FIRST_KEY)
    await runCommand(cli, '/claude logout')
    await cli.waitForText(REMOVED)
    await ready(cli)
    await assertNoClaudeCredential(cli, FIRST_KEY)
    await runCommand(cli, '/claude status')
    await cli.waitForText('Claude não conectado')
  } finally { await cli.stop() }
})

test('connecting the same key twice keeps one account', { timeout: 240_000 }, async () => {
  const cli = await session()
  try {
    await cli.waitForText(IDLE)
    await connectKey(cli, FIRST_KEY)
    const [before] = claudeAccounts(await cli.readSecureStorage())
    await openKeyPrompt(cli)
    await paste(cli, FIRST_KEY)
    await cli.press('enter')
    await cli.waitFor(() => (cli.screenText().match(/conectada \(…/g) ?? []).length >= 2, 60_000)
    await ready(cli)
    const accounts = claudeAccounts(await cli.readSecureStorage())
    assert.equal(accounts.length, 1, 'no duplicate')
    assert.equal(accounts[0].localAccountId, before.localAccountId)
    assert.equal(accounts[0].displayLabel, 'Claude 1')
  } finally { await cli.stop() }
})

test('replacing the key with one of another catalog: /model offers what the new key can use, and it works', { timeout: 300_000 }, async () => {
  const [sonnet, haiku] = DEFAULT_ANTHROPIC_MODELS
  const cli = await session({
    anthropic: {
      responder: record => {
        const key = record.headers['x-api-key']
        if (record.path === '/v1/models') {
          if (key === FIRST_KEY) return { json: { data: [sonnet], has_more: false, first_id: sonnet.id, last_id: sonnet.id } }
          if (key === SECOND_KEY) return { json: { data: [haiku], has_more: false, first_id: haiku.id, last_id: haiku.id } }
          return anthropicErrors.unauthorized()
        }
        if (record.path === '/v1/messages' && record.body?.tools?.length) return { text: CLAUDE_REPLY }
        return undefined
      },
    },
  })
  try {
    await cli.waitForText(IDLE)
    await connectKey(cli, FIRST_KEY)
    await connectKey(cli, SECOND_KEY)
    await pickModel(cli, /Claude Haiku 4\.5/, haiku.id)
    await cli.submit('oi')
    await cli.waitForText(new RegExp(`${CLAUDE_REPLY}|não está disponível para esta conta`))
    assert.doesNotMatch(cli.screenText(), /não está disponível para esta conta/, 'the picker offered a model the key cannot use')
    assert.equal(mainRequestWith(cli.anthropic, 'oi').headers['x-api-key'], SECOND_KEY)
  } finally { await cli.stop() }
})

// ---- 12. Restarting ----

test('restarting keeps the key: the catalog is primed at startup and no new login is needed', { timeout: 300_000 }, async () => {
  const anthropic = await createFakeAnthropic({ responder: acceptOnly(FIRST_KEY) })
  let first
  try {
    first = await session({ anthropic })
    await first.waitForText(IDLE)
    await connectKey(first, FIRST_KEY)
    await pickModel(first, /Claude Sonnet 4\.5/, SONNET)
    await first.stop()

    const catalogBefore = anthropic.modelRequests().length
    const second = await session({ anthropic, reuse: first })
    try {
      await second.waitForText(IDLE)
      await second.waitFor(() => anthropic.modelRequests().length > catalogBefore, 60_000)
      assertKeyOnlyRequest(anthropic.modelRequests()[catalogBefore], FIRST_KEY)
      assert.equal(claudeAccounts(await second.readSecureStorage()).length, 1)

      await runCommand(second, '/claude status')
      await second.waitForText(`Chave em uso: …${FIRST_KEY.slice(-4)}`)
      await ready(second)

      await runCommand(second, '/model')
      await second.waitForText(PICKER_HEADER)
      await delay(300)
      assert.match(second.screenText(), VIA_KEY_ROW, 'the Claude models are there without logging in again')
      await second.press('esc')
      await second.waitForText('Modelo mantido')
      await ready(second)

      await second.submit('oi de novo')
      await second.waitForText(CLAUDE_REPLY)
      const main = mainRequestWith(anthropic, 'oi de novo')
      assert.ok(main, 'the last chosen model is remembered')
      assert.equal(main.body.model, SONNET)
      assertKeyOnlyRequest(main, FIRST_KEY)
      assert.equal(second.router.requests.length, 0)
      assertKeyNeverOnTerminal(second, FIRST_KEY)
    } finally { await second.stop() }
  } finally {
    if (first && !first.exited) await first.stop().catch(() => {})
    await anthropic.close()
  }
})

// ---- 13. Mistakes around the key ----

test('passing the key as an argument (/claude login <key>) is refused and does not keep the key on screen or on disk', { timeout: 240_000 }, async () => {
  const cli = await session()
  try {
    await cli.waitForText(IDLE)
    await runCommand(cli, `/claude login ${FIRST_KEY}`)
    await cli.waitForText('Uso: /claude')
    await ready(cli)
    await delay(1000)
    await assertNoClaudeCredential(cli)
    assert.deepEqual(cli.anthropic.requests, [], 'the key is not validated this way')
    assertRouterNeverSawKey(cli, FIRST_KEY)
    assert.ok(!squeeze(cli.screen()).includes(FIRST_KEY), 'the transcript must not keep the key on screen')
    assert.deepEqual(await filesContaining(cli.dir, FIRST_KEY), [], 'the key must not stay in history or session files')
  } finally { await cli.stop() }
})

// ---- 14. What a real user's session sends (no quiet flags) ----

test('in a real user session the key only goes to the Models and Messages endpoints', { timeout: 300_000 }, async () => {
  const cli = await session({
    unsetEnv: REAL_USER_TRAFFIC_ENV,
    // Known and reported apart: the release check on Verboo's own repository and the startup registry call.
    allowedNetwork: [/\/api\/me\/feedback\/next/, /api\.github\.com\/repos\/verbeux-ai\/code\/releases/, /mcp-registry\/v0\/servers/],
  })
  try {
    await cli.waitForText(IDLE)
    await connectKey(cli, FIRST_KEY)
    await pickModel(cli, /Claude Sonnet 4\.5/, SONNET)
    await cli.submit('oi')
    await cli.waitForText(CLAUDE_REPLY)
    await delay(1500)
    const carriers = cli.anthropic.requests.filter(record => record.headers['x-api-key'] || record.headers.authorization)
    assert.ok(carriers.length > 0)
    const paths = [...new Set(carriers.map(record => record.path))]
    for (const path of paths) assert.ok(['/v1/models', '/v1/messages', '/v1/messages/count_tokens'].includes(path), `credentials sent to ${path}`)
    const anonymous = cli.anthropic.requests.filter(record => !record.headers['x-api-key'] && !record.headers.authorization)
    assert.ok(anonymous.every(record => record.path.startsWith('/mcp-registry/')), `unexpected anonymous requests: ${anonymous.map(record => record.path).join(', ')}`)
    assertRouterNeverSawKey(cli, FIRST_KEY)
    assert.ok(!(await cli.networkLog()).some(entry => entry.includes(FIRST_KEY)))
  } finally { await cli.stop() }
})
