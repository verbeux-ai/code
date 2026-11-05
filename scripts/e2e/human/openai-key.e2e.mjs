// Human-session scenario (#75): connecting an OpenAI API key, sometimes alongside a
// ChatGPT/Codex login. A person types and pastes keys, makes mistakes, recovers, picks
// models with the arrow keys and restarts the CLI. Every test checks what is on screen
// AND the side effects (requests received by the fixtures, keyring, files on disk).
//
// Run: node --test --test-concurrency=1 scripts/e2e/human/openai-key.e2e.mjs
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { CODEX_FIXTURE_ACCOUNT, CODEX_FIXTURE_README, CODEX_FIXTURE_TOKEN } from '../codex-router.mjs'
import { startCli } from '../terminal.mjs'
import { createFakeOpenAI, openaiErrors } from './fake-openai.mjs'
import { hasToolResult, lastUserText, sendChatCompletion } from './http.mjs'
import { openaiApiKeyCredential } from './keyring.mjs'

const TEST_TIMEOUT = 240_000

// All synthetic. KEY_* have no lowercase n on purpose: typed by hand, that letter cancels the dialog (see its test).
const KEY_A = 'sk-proj-fixtureaaaa00000000000000000000-AAAA'
const KEY_B = 'sk-proj-fixturebbbb11111111111111111111-BBBB'
const ANTHROPIC_KEY_PASTED_BY_MISTAKE = 'sk-ant-api03-fixturemistake0000000000000000000000-MIST'
// What platform.openai.com really hands out: long, with _ and -, and full of n.
const LONG_REAL_LOOKING_KEY = `sk-proj-${'nN0_aZ9-Qx7Lm'.repeat(12)}nTaiL`
const EVERY_CHARACTER_BUT_LOWERCASE_N = 'sk-proj-abcdefghijklmopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-WXYZ'
const TYPED_KEY_WITH_N = 'sk-proj-fixture-typed-by-hand-0123456789-LMNO'

// A catalog like the real GET /v1/models: chat models mixed with everything else.
const CHAT_MODELS = ['o4-mini', 'o3', 'gpt-5.5-mini', 'gpt-5.5', 'gpt-4.1', 'chatgpt-4o-latest']
const NON_CHAT_MODELS = ['text-embedding-3-small', 'text-embedding-3-large', 'whisper-1', 'tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'gpt-4o-transcribe', 'dall-e-2', 'dall-e-3', 'gpt-image-1', 'gpt-4o-realtime-preview', 'gpt-4o-audio-preview', 'omni-moderation-latest', 'davinci-002']
const OPENAI_CATALOG = [...NON_CHAT_MODELS.slice(0, 4), ...CHAT_MODELS, ...NON_CHAT_MODELS.slice(4)]
const NON_CHAT_ON_SCREEN = /embedding|whisper|tts|dall-e|image|realtime|transcribe|audio|moderation|davinci/i

const VERBOO_SESSION = 'fixture-session'
const CANCELLED = 'Conexão OpenAI cancelada. O Verboo continua disponível.'
const LOOKS_WRONG = 'Isso não parece uma chave de API da OpenAI'
const REFUSED = 'A OpenAI recusou essa chave. Confira a chave em platform.openai.com.'
const REMOVED = 'Chave da OpenAI removida. O Verboo continua disponível.'
const NOT_CONNECTED = 'OpenAI não conectada. Use /openai login para conectar sua chave de API.'

// A prompt "TURN_X" is answered with "<PROVIDER>_ANSWER TURN_X", so a stale reply on
// screen can never satisfy a later turn. Prompts without a marker keep a plain answer.
// The last marker: a prompt that failed joins the next one in the same user message.
const turnOf = request => [...lastUserText(request).matchAll(/TURN_[A-Z0-9_]+/g)].at(-1)?.[0]
const openaiResponder = record => {
  if (record.path !== '/v1/chat/completions' || !record.body?.tools?.length) return undefined
  const turn = turnOf(record.body)
  return { text: turn ? `OPENAI_ANSWER ${turn}` : 'OPENAI_SIDE_ANSWER' }
}
const verbooRouter = async (req, body, res) => {
  if (req.pathname !== '/router/v1/chat/completions') return undefined
  const turn = body.tools?.length ? turnOf(body) : undefined
  await sendChatCompletion(res, body, { text: turn ? `VERBOO_ANSWER ${turn}` : '{"title":"Fixture session"}' })
  return true
}
const fakeOpenAI = (extra = {}) => ({ models: OPENAI_CATALOG, responder: openaiResponder, ...extra })

// A person's session: no --model, no permission bypass, slash commands on.
function startSession(options = {}) {
  return startCli({ columns: 120, rows: 50, model: null, slashCommands: true, skipPermissions: false, routerOptions: { models: ['fixture-model', 'fixture-model-b'] }, routerHandler: verbooRouter, ...options })
}

async function withSession(options, run) {
  const cli = await startSession(options)
  try {
    await cli.waitForText('Describe a task')
    await run(cli)
  } finally { await cli.stop() }
}

/** Pastes like a real terminal does once the CLI enabled bracketed paste. */
function paste(cli, text) {
  return cli.type(`\x1b[200~${text}\x1b[201~`)
}

async function openLoginDialog(cli) {
  await cli.submit('/openai login')
  await cli.waitForText('Conectar OpenAI com sua chave de API')
  await cli.waitForText('Chave:')
}

/** The dialog redraws asynchronously; a person sees the new state before pressing Enter. */
async function settle(ms = 400) { await delay(ms) }

async function connectKey(cli, key) {
  await openLoginDialog(cli)
  await paste(cli, key)
  await settle()
  await cli.press('enter')
  await cli.waitForText(`Chave da OpenAI conectada (…${key.slice(-4)})`)
}

const focusedRow = cli => cli.screen().split('\n').find(line => /^\s*❯\s+\d+\.\s/.test(line)) ?? ''
const optionRows = cli => cli.screen().split('\n').filter(line => /^\s*(❯\s+)?\d+\.\s/.test(line))

async function openModelPicker(cli) {
  await cli.submit('/model')
  await cli.waitForText('Select model')
  await cli.waitFor(() => focusedRow(cli), 60_000)
}

async function pressDownAndWait(cli, timeout = 10_000) {
  const before = focusedRow(cli)
  await cli.press('down')
  await cli.waitFor(() => focusedRow(cli) !== before, timeout)
}

/** Opens /model and walks with the arrow keys to the row a person would read, then Enter. */
async function pickModel(cli, rowPattern, confirmation) {
  await openModelPicker(cli)
  for (let moves = 0; moves < 30 && !rowPattern.test(focusedRow(cli)); moves++) await pressDownAndWait(cli)
  assert.match(focusedRow(cli), rowPattern, `no /model row matches ${rowPattern}:\n${cli.screen()}`)
  await cli.press('enter')
  await cli.waitForText(confirmation)
}
const OPENAI_GPT_55_ROW = /\d+\.\s+gpt-5\.5 \(sua chave OpenAI\)/
const pickOpenAIGpt55 = cli => pickModel(cli, OPENAI_GPT_55_ROW, 'Modelo alterado para openai-api/gpt-5.5')

/** Sends one prompt and waits until the whole turn has finished rendering. */
async function say(cli, turn, answer) {
  await cli.submit(`${turn}: say hello.`)
  await cli.waitForText(answer)
}

const mainChats = (openai, turn) => openai.chatRequests().filter(record => record.body.tools?.length && lastUserText(record.body).includes(turn))
const routerChats = (cli, turn) => cli.router.requests.filter(body => lastUserText(body).includes(turn))

async function collectFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
}

/** Every place a key must never show up: the terminal, logs, config, sessions and the other servers. */
async function assertSecretNotLeaked(cli, secret, { fragments = true } = {}) {
  const middle = secret.slice(Math.floor(secret.length / 2) - 4, Math.floor(secret.length / 2) + 4)
  const onScreen = [cli.raw, ...cli.frames.map(frame => frame.text.replace(/\s+/g, ''))]
  for (const text of onScreen) {
    assert.ok(!text.includes(secret), 'the whole key was rendered in the terminal')
    if (fragments) assert.ok(!text.includes(middle), `a key fragment (${middle}) was rendered in the terminal`)
  }
  const files = [join(cli.runDir, 'debug.log')]
  for (const root of [cli.config, cli.home, cli.projectsDir, cli.project, join(cli.dir, 'tmp')]) files.push(...await collectFiles(root))
  for (const file of files) {
    const text = await readFile(file, 'latin1').catch(() => '')
    assert.ok(!text.includes(secret), `the key is in plain text in ${file}`)
  }
  assert.ok(!(await readFile(join(cli.keyringDir, 'ops.log'), 'utf8')).includes(secret), 'the key went to secret-tool as an argument')
  const records = [...cli.router.allRequests, ...(cli.codexProxy?.requests ?? [])]
  assert.ok(!JSON.stringify(records.map(({ headers, body, path, query }) => ({ headers, body, path, query }))).includes(secret), 'the key reached the Verboo router or Codex')
}

/** The screen line(s) of the masked field, without whitespace. */
function maskedField(cli) {
  const lines = cli.screen().split('\n')
  const start = lines.findIndex(line => line.startsWith('Chave:'))
  if (start === -1) return ''
  const field = [lines[start].slice('Chave:'.length)]
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || !/^[ \S]*\*/.test(line)) break
    field.push(line)
  }
  return field.join('').replace(/\s+/g, '')
}

// ---- Connecting: mistakes and recoveries -----------------------------------

test('invalid format: junk, a too-short sk- key and an empty Enter are refused without calling OpenAI', { timeout: TEST_TIMEOUT }, () => withSession({ openai: fakeOpenAI() }, async cli => {
  await openLoginDialog(cli)
  await cli.type('chave-errada-123', { delayMs: 15 })
  await settle()
  await cli.press('enter')
  await cli.waitForText(LOOKS_WRONG)
  assert.match(cli.screenText(), /Enter para confirmar · Esc para cancelar/, 'the dialog stays open so the person can fix it')

  await cli.press('ctrl-u')
  await settle()
  await cli.type('sk-abc123')
  await settle()
  await cli.press('enter')
  await settle(800)
  assert.ok(cli.screenText().includes(LOOKS_WRONG), 'an sk- key that is too short is still not a key')

  await cli.press('ctrl-u')
  await settle()
  await cli.press('enter')
  await settle(800)
  assert.ok(cli.screenText().includes(LOOKS_WRONG), 'an empty Enter gets the same explanation')

  assert.equal(cli.openai.requests.length, 0, 'nothing that fails the format check may be sent to OpenAI')
  assert.equal((await cli.readSecureStorage())?.openaiApiKey, undefined)
  assert.equal(await cli.readPlainTextCredentials(), null)
}))

test('sk-ant- key pasted by mistake: refused locally, never sent anywhere; pasting the right key recovers', { timeout: TEST_TIMEOUT }, () => withSession({ openai: fakeOpenAI() }, async cli => {
  await openLoginDialog(cli)
  await paste(cli, ANTHROPIC_KEY_PASTED_BY_MISTAKE)
  await settle()
  await cli.press('enter')
  await cli.waitForText(LOOKS_WRONG)
  assert.equal(cli.openai.requests.length, 0, 'an sk-ant- key must not be sent to OpenAI to find out it is wrong')
  const stored = await cli.readSecureStorage()
  assert.equal(stored?.openaiApiKey, undefined)
  assert.equal(stored?.claudeNative, undefined, 'it must not be filed as a Claude key either')

  await cli.press('ctrl-u')
  await settle()
  await paste(cli, KEY_A)
  await settle()
  await cli.press('enter')
  await cli.waitForText('Chave da OpenAI conectada (…AAAA)')
  assert.deepEqual(cli.openai.modelRequests().map(record => record.headers.authorization), [`Bearer ${KEY_A}`, `Bearer ${KEY_A}`])
  assert.deepEqual((await cli.readSecureStorage()).openaiApiKey, { apiKey: KEY_A, keyHint: 'AAAA' })
  assert.ok(!JSON.stringify(cli.openai.requests.map(({ headers, raw }) => ({ headers, raw }))).includes(ANTHROPIC_KEY_PASTED_BY_MISTAKE))
  await assertSecretNotLeaked(cli, ANTHROPIC_KEY_PASTED_BY_MISTAKE)
}))

test('401 from OpenAI: "recusou essa chave", nothing is stored; correcting the key connects', { timeout: TEST_TIMEOUT }, () => withSession({ openai: fakeOpenAI() }, async cli => {
  cli.openai.enqueue(openaiErrors.invalidApiKey(), { path: '/v1/models' })
  await openLoginDialog(cli)
  await paste(cli, KEY_B)
  await settle()
  await cli.press('enter')
  await cli.waitForText(REFUSED)
  assert.equal(cli.openai.modelRequests().length, 1)
  assert.equal(cli.openai.modelRequests()[0].headers.authorization, `Bearer ${KEY_B}`)
  assert.equal((await cli.readSecureStorage())?.openaiApiKey, undefined, 'a refused key must not be stored')
  assert.equal(await cli.readPlainTextCredentials(), null)
  assert.ok(!cli.screenText().includes('Incorrect API key'), 'the friendly message replaces the raw API error')
  await assertSecretNotLeaked(cli, KEY_B)

  // The person fixes the key by erasing it with Backspace, as most people do.
  await cli.press('backspace', KEY_B.length)
  await settle()
  await paste(cli, KEY_A)
  await settle()
  await cli.press('enter')
  await cli.waitForText('Chave da OpenAI conectada (…AAAA)')
  assert.deepEqual((await cli.readSecureStorage()).openaiApiKey, { apiKey: KEY_A, keyHint: 'AAAA' })
}))

test('403 from OpenAI (restricted key) is also "recusou essa chave" and stores nothing', { timeout: TEST_TIMEOUT }, () => withSession({ openai: fakeOpenAI() }, async cli => {
  cli.openai.enqueue({ status: 403, json: { error: { message: 'You have insufficient permissions for this operation. Missing scopes: api.model.read.', type: 'invalid_request_error', param: null, code: null } } }, { path: '/v1/models' })
  await openLoginDialog(cli)
  await paste(cli, KEY_A)
  await settle()
  await cli.press('enter')
  await cli.waitForText(REFUSED)
  assert.equal((await cli.readSecureStorage())?.openaiApiKey, undefined)
}))

test('OpenAI down during validation: says it could not validate, stores nothing; Enter again retries and connects', { timeout: TEST_TIMEOUT }, () => withSession({ openai: fakeOpenAI() }, async cli => {
  cli.openai.enqueue(openaiErrors.serverError(), { path: '/v1/models' })
  await openLoginDialog(cli)
  await paste(cli, KEY_A)
  await settle()
  await cli.press('enter')
  await cli.waitForText('Não foi possível validar a chave')
  assert.equal((await cli.readSecureStorage())?.openaiApiKey, undefined)
  await assertSecretNotLeaked(cli, KEY_A)

  await cli.press('enter')
  await cli.waitForText('Chave da OpenAI conectada (…AAAA)')
  assert.deepEqual((await cli.readSecureStorage()).openaiApiKey, { apiKey: KEY_A, keyHint: 'AAAA' })
}))

test('a key that only sees non-chat models is explained and not stored', { timeout: TEST_TIMEOUT }, () => withSession({ openai: fakeOpenAI({ models: NON_CHAT_MODELS }) }, async cli => {
  await openLoginDialog(cli)
  await paste(cli, KEY_A)
  await settle()
  await cli.press('enter')
  await cli.waitForText('A chave foi aceita, mas a OpenAI não retornou nenhum modelo de chat')
  assert.equal((await cli.readSecureStorage())?.openaiApiKey, undefined)
}))

test('valid key: success with the filtered model count, stored only in the keyring', { timeout: TEST_TIMEOUT }, () => withSession({ openai: fakeOpenAI() }, async cli => {
  assert.equal(await cli.readSecureStorage(), null)
  await connectKey(cli, KEY_A)
  await cli.waitForText(`Chave da OpenAI conectada (…AAAA). ${CHAT_MODELS.length} modelo(s) GPT liberado(s), cobrados pela OpenAI na sua chave. Use /model para escolher.`)
  const validation = cli.openai.modelRequests()[0]
  assert.equal(validation.headers.authorization, `Bearer ${KEY_A}`)
  assert.deepEqual((await cli.readSecureStorage()).openaiApiKey, { apiKey: KEY_A, keyHint: 'AAAA' })
  assert.ok((await cli.keyringOps()).some(op => op.action === 'store'), 'written through secret-tool')
  assert.equal(await cli.readPlainTextCredentials(), null, 'no plain-text credentials file')
  await assertSecretNotLeaked(cli, KEY_A)
  assert.equal(cli.router.requests.length, 0, 'connecting a key is not a model turn')
}))

// ---- Masking ---------------------------------------------------------------

test('paste a long real-looking key copied with a trailing newline: masked in every frame, stored clean', { timeout: TEST_TIMEOUT }, () => withSession({ openai: fakeOpenAI() }, async cli => {
  await openLoginDialog(cli)
  const framesBefore = cli.frames.length
  await paste(cli, `${LONG_REAL_LOOKING_KEY}\n`)
  await settle(600)
  const field = maskedField(cli)
  assert.match(field, /^sk-\*+/, `the field must show a mask, got:\n${cli.screen()}`)
  assert.ok(!field.replace(/\*/g, '').includes(LONG_REAL_LOOKING_KEY.slice(3, 11)), 'the key body must be hidden')
  for (const frame of cli.frames.slice(framesBefore)) assert.ok(!frame.text.includes(LONG_REAL_LOOKING_KEY.slice(20, 40)), 'a key fragment was rendered')
  await cli.press('enter')
  await cli.waitForText(`Chave da OpenAI conectada (…${LONG_REAL_LOOKING_KEY.slice(-4)})`)
  assert.equal((await cli.readSecureStorage()).openaiApiKey.apiKey, LONG_REAL_LOOKING_KEY, 'the whole key, trimmed, no line break')
  assert.equal(cli.openai.modelRequests()[0].headers.authorization, `Bearer ${LONG_REAL_LOOKING_KEY}`)
  await assertSecretNotLeaked(cli, LONG_REAL_LOOKING_KEY)
}))

test('paste in a terminal without bracketed paste (whole key in one chunk) also connects, masked', { timeout: TEST_TIMEOUT }, () => withSession({ openai: fakeOpenAI() }, async cli => {
  await openLoginDialog(cli)
  await cli.type(LONG_REAL_LOOKING_KEY)
  await settle(600)
  assert.match(maskedField(cli), /^sk-\*+/)
  await cli.press('enter')
  await cli.waitForText(`Chave da OpenAI conectada (…${LONG_REAL_LOOKING_KEY.slice(-4)})`)
  assert.equal((await cli.readSecureStorage()).openaiApiKey.apiKey, LONG_REAL_LOOKING_KEY)
  await assertSecretNotLeaked(cli, LONG_REAL_LOOKING_KEY)
}))

test('typing a key by hand: only the first and last 3 characters are ever visible, every character arrives', { timeout: TEST_TIMEOUT }, () => withSession({ openai: fakeOpenAI() }, async cli => {
  await openLoginDialog(cli)
  const framesBefore = cli.frames.length
  await cli.type(EVERY_CHARACTER_BUT_LOWERCASE_N, { delayMs: 15 })
  await settle()
  assert.equal(maskedField(cli), `sk-${'*'.repeat(EVERY_CHARACTER_BUT_LOWERCASE_N.length - 6)}XYZ`)
  for (const frame of cli.frames.slice(framesBefore)) {
    const line = frame.text.split('\n').find(text => text.startsWith('Chave:'))?.slice('Chave:'.length).trim() ?? ''
    assert.match(line, /^(.{0,3}\**.{0,3})?$/, `more than the edges were visible in a frame: ${line}`)
  }
  await cli.press('enter')
  await cli.waitForText('Chave da OpenAI conectada (…WXYZ)')
  assert.equal((await cli.readSecureStorage()).openaiApiKey.apiKey, EVERY_CHARACTER_BUT_LOWERCASE_N)
  await assertSecretNotLeaked(cli, EVERY_CHARACTER_BUT_LOWERCASE_N)
}))

test('typing a key by hand that contains the letter n keeps the dialog open and the key masked', { timeout: TEST_TIMEOUT }, () => withSession({ openai: fakeOpenAI() }, async cli => {
  await openLoginDialog(cli)
  await cli.type(TYPED_KEY_WITH_N, { delayMs: 25 })
  await settle()
  const screen = cli.screenText()
  assert.ok(!screen.includes(CANCELLED), `typing "n" in the key field must not cancel the dialog. The rest of the key went to the main prompt, in clear text:\n${cli.screen()}`)
  assert.equal(maskedField(cli), `sk-${'*'.repeat(TYPED_KEY_WITH_N.length - 6)}MNO`)
  await cli.press('enter')
  await cli.waitForText('Chave da OpenAI conectada (…LMNO)')
  assert.equal((await cli.readSecureStorage()).openaiApiKey.apiKey, TYPED_KEY_WITH_N)
}))

test('Esc and Ctrl+C cancel the dialog, keep the CLI alive and discard what was typed', { timeout: TEST_TIMEOUT }, () => withSession({ openai: fakeOpenAI() }, async cli => {
  await openLoginDialog(cli)
  await cli.type('sk-proj-half-typed', { delayMs: 15 })
  await settle()
  await cli.press('esc')
  await cli.waitForText(CANCELLED)
  await settle()
  assert.match(cli.screenText(), /Describe a task/, 'the prompt is back and empty')
  assert.ok(!cli.screenText().includes('half-typed'))

  await openLoginDialog(cli)
  await cli.type('sk-proj-half-typed', { delayMs: 15 })
  await settle()
  await cli.press('ctrl-c')
  await cli.waitFor(() => (cli.screenText().match(new RegExp(CANCELLED, 'g')) ?? []).length === 2, 60_000)
  await settle()
  assert.equal(cli.exited, undefined, 'Ctrl+C in the dialog must not quit the CLI')
  assert.match(cli.screenText(), /Describe a task/)

  assert.equal(cli.openai.requests.length, 0)
  assert.equal((await cli.readSecureStorage())?.openaiApiKey, undefined)
  await say(cli, 'TURN_AFTER_CANCEL', 'VERBOO_ANSWER TURN_AFTER_CANCEL')
}))

// ---- /model ----------------------------------------------------------------

test('/model lists the chat models as "(sua chave OpenAI)" and none of the non-chat ones', { timeout: TEST_TIMEOUT }, () => withSession({ openai: fakeOpenAI() }, async cli => {
  await connectKey(cli, KEY_A)
  await openModelPicker(cli)
  // A person scrolls through the whole list.
  const seen = new Map()
  const collect = () => { for (const row of optionRows(cli)) { const match = /\d+\.\s+(.*)$/.exec(row); seen.set(match[1].split(/\s{2,}/)[0].replace(/\s*[✔…].*$/, '').trim(), row) } }
  collect()
  for (let moves = 0; moves < 40; moves++) {
    const before = focusedRow(cli)
    await cli.press('down')
    await delay(150)
    collect()
    if (focusedRow(cli) === before || /^\s*❯\s+1\./.test(focusedRow(cli))) break
  }
  const labels = [...seen.keys()]
  assert.deepEqual(labels.slice().sort(), ['fixture-model', 'fixture-model-b', ...CHAT_MODELS.map(id => `${id} (sua chave OpenAI)`)].sort())
  for (const id of CHAT_MODELS) assert.ok(seen.get(`${id} (sua chave OpenAI)`).includes(`${id} · cobrado pela OpenAI na sua chave`), `row for ${id}`)
  assert.doesNotMatch(labels.join('\n'), NON_CHAT_ON_SCREEN)
  assert.doesNotMatch([...seen.values()].join('\n'), NON_CHAT_ON_SCREEN)

  await cli.press('esc')
  await cli.waitForText('Modelo mantido.')
  assert.equal((await cli.readSecureStorage()).openaiApiKey.apiKey, KEY_A)
  assert.equal(cli.router.requests.length, 0)
}))

test('/model <id> works for openai-api/gpt-5.5 only while connected, and never for a filtered model', { timeout: TEST_TIMEOUT }, () => withSession({ openai: fakeOpenAI() }, async cli => {
  await cli.submit('/model openai-api/gpt-5.5')
  await cli.waitForText("O modelo 'openai-api/gpt-5.5' não está disponível")
  await connectKey(cli, KEY_A)
  await cli.submit('/model openai-api/text-embedding-3-small')
  await cli.waitForText("O modelo 'openai-api/text-embedding-3-small' não está disponível")
  await cli.submit('/model openai-api/gpt-5.5')
  await cli.waitForText('Modelo alterado para openai-api/gpt-5.5')
  await cli.waitForText('OpenAI openai-api/gpt-5.5')
}))

test('picking gpt-5.5 with the arrow keys on an 80x24 terminal: OpenAI gets the bare model id and the key, the router gets nothing', { timeout: TEST_TIMEOUT }, () => withSession({ columns: 80, rows: 24, openai: fakeOpenAI() }, async cli => {
  await connectKey(cli, KEY_A)
  await pickOpenAIGpt55(cli)
  await cli.waitForText('OpenAI openai-api/gpt-5.5')
  await say(cli, 'TURN_FIRST_MESSAGE', 'OPENAI_ANSWER TURN_FIRST_MESSAGE')

  const main = mainChats(cli.openai, 'TURN_FIRST_MESSAGE')
  assert.equal(main.length, 1, 'one prompt, one main request')
  assert.equal(main[0].body.stream, true)
  const sent = cli.openai.chatRequests()
  assert.ok(sent.length >= 1)
  for (const record of sent) {
    assert.equal(record.body.model, 'gpt-5.5', 'the openai-api/ prefix is ours, OpenAI must never see it')
    assert.equal(record.headers.authorization, `Bearer ${KEY_A}`)
    // The wire format current GPT models accept on /v1/chat/completions.
    assert.equal(record.body.max_tokens, undefined, 'max_tokens is rejected by current GPT models; max_completion_tokens is the field')
    assert.ok(record.body.max_completion_tokens > 0)
  }
  for (const record of cli.openai.requests) {
    const headers = Object.keys(record.headers)
    assert.deepEqual(headers.filter(name => /^(x-verboo|x-claude|x-app$|x-client-app$|x-anthropic|anthropic-)/i.test(name)), [], `${record.method} ${record.path} carries a Verboo/Claude header`)
    assert.deepEqual(headers.filter(name => /^x-/i.test(name) && name !== 'x-client-request-id'), [], `${record.method} ${record.path} carries an unexpected x- header`)
    assert.ok(!JSON.stringify(record.headers).includes(VERBOO_SESSION), 'the Verboo session must not reach OpenAI')
    assert.ok(!record.raw.includes(VERBOO_SESSION), 'the Verboo session must not be in the body')
  }
  assert.equal(cli.router.requests.length, 0, 'no chat request (main or side query) may reach the Verboo router')
  await assertSecretNotLeaked(cli, KEY_A)
  assert.ok(!cli.router.allRequests.some(record => JSON.stringify(record.headers).includes(KEY_A)))
}))

test('requests to OpenAI identify the CLI as Verboo Code, not as another product', { timeout: TEST_TIMEOUT }, () => withSession({ openai: fakeOpenAI(), secureStorage: { openaiApiKey: openaiApiKeyCredential(KEY_A) } }, async cli => {
  await cli.waitFor(() => cli.openai.modelRequests().length > 0, 60_000)
  await pickOpenAIGpt55(cli)
  await say(cli, 'TURN_USER_AGENT', 'OPENAI_ANSWER TURN_USER_AGENT')
  const agents = new Map(cli.openai.requests.map(record => [`${record.method} ${record.path}`, record.headers['user-agent']]))
  for (const [route, agent] of agents) assert.match(agent ?? '', /^verboo-code\//, `${route} sent User-Agent "${agent}"`)
}))

test('a tool call round-trips through the user key: the README content goes back to OpenAI as a tool message', { timeout: TEST_TIMEOUT }, async () => {
  const toolAwareResponder = record => {
    if (record.path !== '/v1/chat/completions' || !record.body?.tools?.length) return undefined
    if (!lastUserText(record.body).includes('TURN_TOOL') && !hasToolResult(record.body)) return { text: 'OPENAI_SIDE_ANSWER' }
    return hasToolResult(record.body) ? { text: 'OPENAI_ANSWER TURN_TOOL_DONE' } : { toolCalls: [{ name: 'Read', arguments: { file_path: 'README.md' } }] }
  }
  await withSession({ openai: fakeOpenAI({ responder: toolAwareResponder }), secureStorage: { openaiApiKey: openaiApiKeyCredential(KEY_A) } }, async cli => {
    await cli.waitFor(() => cli.openai.modelRequests().length > 0, 60_000)
    await pickOpenAIGpt55(cli)
    await cli.submit('TURN_TOOL: read the README.')
    await cli.waitForText('OPENAI_ANSWER TURN_TOOL_DONE')
    const withResult = cli.openai.chatRequests().find(record => record.body.tools?.length && hasToolResult(record.body))
    assert.ok(withResult, 'the tool result must go back to OpenAI')
    const toolMessage = withResult.body.messages.find(message => message.role === 'tool')
    assert.ok(JSON.stringify(toolMessage.content).includes(CODEX_FIXTURE_README), 'the real file content must be in the tool message')
    assert.equal(withResult.body.model, 'gpt-5.5')
    assert.equal(cli.router.requests.length, 0)
  })
})

// ---- Alongside a ChatGPT/Codex login ----------------------------------------

// --effort high is what the Codex fixture requires of user turns. A real shell has no OPENAI_MODEL.
const withCodex = (options = {}) => ({ codexHandler: () => undefined, unsetEnv: ['OPENAI_MODEL'], args: ['--effort', 'high'], userSettings: { autoMemoryEnabled: false }, ...options })
const CODEX_GPT_55_ROW = /\d+\.\s+gpt-5\.5\s{2,}.*via Codex/
const codexResponses = cli => cli.codexProxy.requests.filter(record => record.path === '/backend-api/codex/responses')

// /model sets the effort of what the person picks, so the fixture's --effort high rule does not apply here.
test('with Codex connected, gpt-5.5 (Codex) and openai-api/gpt-5.5 are both listed and each goes to its own server', { timeout: TEST_TIMEOUT }, () => withSession(withCodex({ codexOptions: { anyEffort: true }, openai: fakeOpenAI() }), async cli => {
  await connectKey(cli, KEY_A)
  assert.equal((await cli.readSecureStorage()).codex.accessToken, CODEX_FIXTURE_TOKEN, 'saving the key must keep the Codex login')

  await openModelPicker(cli)
  const rows = []
  for (let moves = 0; moves < 20; moves++) {
    rows.push(...optionRows(cli))
    const before = focusedRow(cli)
    await cli.press('down')
    await delay(150)
    if (focusedRow(cli) === before || /^\s*❯\s+1\./.test(focusedRow(cli))) break
  }
  assert.ok(rows.some(row => CODEX_GPT_55_ROW.test(row)), `the Codex gpt-5.5 row is missing:\n${cli.screen()}`)
  assert.ok(rows.some(row => OPENAI_GPT_55_ROW.test(row)), `the OpenAI gpt-5.5 row is missing:\n${cli.screen()}`)
  await cli.press('esc')
  await cli.waitForText('Modelo mantido.')

  await pickOpenAIGpt55(cli)
  await cli.waitForText('OpenAI openai-api/gpt-5.5')
  await say(cli, 'TURN_VIA_KEY', 'OPENAI_ANSWER TURN_VIA_KEY')
  const viaKey = mainChats(cli.openai, 'TURN_VIA_KEY')
  assert.equal(viaKey.length, 1)
  assert.equal(viaKey[0].body.model, 'gpt-5.5')
  assert.equal(viaKey[0].headers.authorization, `Bearer ${KEY_A}`)
  assert.equal(viaKey[0].headers['chatgpt-account-id'], undefined, 'the ChatGPT account is not OpenAI API business')
  assert.equal(viaKey[0].headers.originator, undefined)
  assert.ok(!JSON.stringify(codexResponses(cli).map(record => record.body)).includes('TURN_VIA_KEY'), 'this turn must not reach Codex')
  const codexPostsBefore = codexResponses(cli).length

  await pickModel(cli, CODEX_GPT_55_ROW, 'Modelo alterado para gpt-5.5')
  await cli.waitForText('Codex gpt-5.5')
  const openaiChatsBefore = cli.openai.chatRequests().length
  await cli.submit('CODEX_E2E_SIMPLE: Say exactly that the Codex transport answered.')
  await cli.waitForText('CODEX_E2E_SIMPLE_REPLY')
  const viaCodex = codexResponses(cli).slice(codexPostsBefore).filter(record => JSON.stringify(record.body.input).includes('CODEX_E2E_SIMPLE'))
  assert.ok(viaCodex.length >= 1, 'this turn must reach Codex')
  for (const record of viaCodex) {
    assert.equal(record.body.model, 'gpt-5.5')
    assert.equal(record.headers.authorization, `Bearer ${CODEX_FIXTURE_TOKEN}`, 'Codex gets the ChatGPT token, not the API key')
    assert.equal(record.headers['chatgpt-account-id'], CODEX_FIXTURE_ACCOUNT)
  }
  assert.equal(cli.openai.chatRequests().length, openaiChatsBefore, 'the Codex turn must not reach the OpenAI API')

  await pickOpenAIGpt55(cli)
  // The confirmation is already on screen from the first switch: wait for the footer, or the prompt lands on the open picker.
  await cli.waitForText(/OpenAI openai-api\/gpt-5\.5 · context/)
  await say(cli, 'TURN_BACK_TO_KEY', 'OPENAI_ANSWER TURN_BACK_TO_KEY')
  assert.equal(mainChats(cli.openai, 'TURN_BACK_TO_KEY').length, 1)

  for (const record of cli.openai.requests) assert.ok(!JSON.stringify(record.headers).includes(CODEX_FIXTURE_TOKEN) && !record.raw.includes(CODEX_FIXTURE_TOKEN), 'the ChatGPT token must not reach the OpenAI API')
  assert.ok(!cli.router.allRequests.some(record => JSON.stringify(record.headers).includes(CODEX_FIXTURE_TOKEN)))
  assert.deepEqual(cli.codexRouter.violations, [])
  await assertSecretNotLeaked(cli, KEY_A)
}))

test('/openai logout with Codex connected removes only the key: Codex keeps its login and its gpt-5.5', { timeout: TEST_TIMEOUT }, () => withSession(withCodex({ openai: fakeOpenAI(), secureStorage: { openaiApiKey: openaiApiKeyCredential(KEY_A) } }), async cli => {
  await cli.waitFor(() => cli.openai.modelRequests().length > 0, 60_000)
  await pickOpenAIGpt55(cli)
  await cli.submit('/openai logout')
  await cli.waitForText(REMOVED)
  await cli.waitForText(/Verboo fixture-model/)
  const stored = await cli.readSecureStorage()
  assert.equal(stored.openaiApiKey, undefined)
  assert.equal(stored.codex.accessToken, CODEX_FIXTURE_TOKEN)

  await openModelPicker(cli)
  const rows = []
  for (let moves = 0; moves < 10; moves++) {
    rows.push(...optionRows(cli))
    const before = focusedRow(cli)
    await cli.press('down')
    await delay(150)
    if (focusedRow(cli) === before || /^\s*❯\s+1\./.test(focusedRow(cli))) break
  }
  assert.ok(rows.some(row => CODEX_GPT_55_ROW.test(row)), 'Codex stays listed')
  assert.ok(!rows.some(row => row.includes('sua chave OpenAI')), 'the OpenAI entries are gone')
  await cli.press('esc')
}))

test('the Verboo catalog also has gpt-5.5: the plain id goes to the router, openai-api/gpt-5.5 goes to OpenAI', { timeout: TEST_TIMEOUT }, () => withSession({
  routerOptions: { models: ['fixture-model', 'gpt-5.5'] },
  openai: fakeOpenAI(), secureStorage: { openaiApiKey: openaiApiKeyCredential(KEY_A) },
}, async cli => {
  await cli.waitFor(() => cli.openai.modelRequests().length > 0, 60_000)
  await pickOpenAIGpt55(cli)
  await say(cli, 'TURN_KEY_SIDE', 'OPENAI_ANSWER TURN_KEY_SIDE')
  assert.equal(mainChats(cli.openai, 'TURN_KEY_SIDE')[0].body.model, 'gpt-5.5')
  assert.deepEqual(routerChats(cli, 'TURN_KEY_SIDE'), [])

  await pickModel(cli, /\d+\.\s+gpt-5\.5\s{2,}(?!.*sua chave)/, 'Modelo alterado para gpt-5.5')
  const openaiBefore = cli.openai.chatRequests().length
  await say(cli, 'TURN_ROUTER_SIDE', 'VERBOO_ANSWER TURN_ROUTER_SIDE')
  assert.ok(routerChats(cli, 'TURN_ROUTER_SIDE').some(body => body.model === 'gpt-5.5'))
  assert.equal(cli.openai.chatRequests().length, openaiBefore)
  await assertSecretNotLeaked(cli, KEY_A)
}))

// ---- Status, rotation, logout, restart --------------------------------------

test('/openai status: not connected, then only the last 4 characters; usage for anything else', { timeout: TEST_TIMEOUT }, () => withSession({ openai: fakeOpenAI() }, async cli => {
  await cli.submit('/openai status')
  await cli.waitForText(NOT_CONNECTED)
  await cli.submit('/openai qualquer-coisa')
  await cli.waitForText('Uso: /openai [login|status|logout]')

  await connectKey(cli, KEY_A)
  const requestsBefore = cli.openai.requests.length
  await cli.submit('/openai status')
  await cli.waitForText('OpenAI conectada com a chave …AAAA.')
  assert.equal(cli.openai.requests.length, requestsBefore, 'status is local: it does not spend or call anything')
  await assertSecretNotLeaked(cli, KEY_A)
}))

test('connecting a second key replaces the first for the very next message, without a restart', { timeout: TEST_TIMEOUT }, () => withSession({ openai: fakeOpenAI(), secureStorage: { fixtureSibling: 'kept' } }, async cli => {
  await connectKey(cli, KEY_A)
  await pickOpenAIGpt55(cli)
  await say(cli, 'TURN_OLD_KEY', 'OPENAI_ANSWER TURN_OLD_KEY')
  assert.equal(mainChats(cli.openai, 'TURN_OLD_KEY')[0].headers.authorization, `Bearer ${KEY_A}`)

  await connectKey(cli, KEY_B)
  await cli.submit('/openai status')
  await cli.waitForText('OpenAI conectada com a chave …BBBB.')
  await say(cli, 'TURN_NEW_KEY', 'OPENAI_ANSWER TURN_NEW_KEY')
  assert.equal(mainChats(cli.openai, 'TURN_NEW_KEY')[0].headers.authorization, `Bearer ${KEY_B}`)
  const stored = await cli.readSecureStorage()
  assert.deepEqual(stored.openaiApiKey, { apiKey: KEY_B, keyHint: 'BBBB' })
  assert.equal(stored.fixtureSibling, 'kept', 'other records survive')
  assert.equal(JSON.stringify(stored).includes(KEY_A), false, 'the old key is gone')
}))

test('/openai logout with an OpenAI model selected: falls back to Verboo, key gone, siblings kept, nothing else reaches OpenAI', { timeout: TEST_TIMEOUT }, () => withSession({ openai: fakeOpenAI(), secureStorage: { fixtureSibling: 'kept', openaiApiKey: openaiApiKeyCredential(KEY_A) } }, async cli => {
  await cli.waitFor(() => cli.openai.modelRequests().length > 0, 60_000)
  await pickOpenAIGpt55(cli)
  await say(cli, 'TURN_BEFORE_LOGOUT', 'OPENAI_ANSWER TURN_BEFORE_LOGOUT')

  await cli.submit('/openai logout')
  await cli.waitForText(REMOVED)
  await cli.waitForText('Verboo fixture-model')
  const stored = await cli.readSecureStorage()
  assert.equal(stored.openaiApiKey, undefined, 'the key must be removed from the keyring')
  assert.equal(stored.fixtureSibling, 'kept', 'other records survive')

  const openaiChats = cli.openai.chatRequests().length
  await say(cli, 'TURN_AFTER_LOGOUT', 'VERBOO_ANSWER TURN_AFTER_LOGOUT')
  const toRouter = routerChats(cli, 'TURN_AFTER_LOGOUT').filter(body => body.tools?.length)
  assert.equal(toRouter.length, 1)
  assert.equal(toRouter[0].model, 'fixture-model')
  assert.equal(cli.openai.chatRequests().length, openaiChats, 'nothing may be billed to the removed key')

  await cli.submit('/openai status')
  await cli.waitForText(NOT_CONNECTED)
  await cli.submit('/model openai-api/gpt-5.5')
  await cli.waitForText("O modelo 'openai-api/gpt-5.5' não está disponível")
  await openModelPicker(cli)
  assert.ok(!cli.screenText().includes('sua chave OpenAI'), `the OpenAI entries must be gone:\n${cli.screen()}`)
  await cli.press('esc')
  await assertSecretNotLeaked(cli, KEY_A)
}))

test('/openai logout while on a Verboo model keeps that model selected', { timeout: TEST_TIMEOUT }, () => withSession({ openai: fakeOpenAI(), secureStorage: { openaiApiKey: openaiApiKeyCredential(KEY_A) } }, async cli => {
  await cli.waitFor(() => cli.openai.modelRequests().length > 0, 60_000)
  await pickModel(cli, /\d+\.\s+fixture-model-b/, 'Modelo alterado para fixture-model-b')
  await cli.submit('/openai logout')
  await cli.waitForText(REMOVED)
  await cli.waitForText('Verboo fixture-model-b')
  await say(cli, 'TURN_STAYS_B', 'VERBOO_ANSWER TURN_STAYS_B')
  assert.equal(routerChats(cli, 'TURN_STAYS_B').filter(body => body.tools?.length)[0].model, 'fixture-model-b')
}))

test('restart keeps the key and the last model: no new login, next message goes to OpenAI with the same key', { timeout: TEST_TIMEOUT }, async () => {
  const openai = await createFakeOpenAI(fakeOpenAI())
  let first, second
  try {
    first = await startSession({ openai })
    await first.waitForText('Describe a task')
    await connectKey(first, KEY_A)
    await pickOpenAIGpt55(first)
    await say(first, 'TURN_BEFORE_RESTART', 'OPENAI_ANSWER TURN_BEFORE_RESTART')
    await first.stop()
    const storeOpsBefore = (await first.keyringOps()).filter(op => op.action === 'store').length

    second = await startSession({ reuse: first, openai })
    await second.waitForText('Describe a task')
    await second.waitForText('OpenAI openai-api/gpt-5.5')
    await second.submit('/openai status')
    await second.waitForText('OpenAI conectada com a chave …AAAA.')
    await say(second, 'TURN_AFTER_RESTART', 'OPENAI_ANSWER TURN_AFTER_RESTART')

    const main = mainChats(openai, 'TURN_AFTER_RESTART')
    assert.equal(main.length, 1)
    assert.equal(main[0].body.model, 'gpt-5.5')
    assert.equal(main[0].headers.authorization, `Bearer ${KEY_A}`)
    assert.deepEqual((await second.readSecureStorage()).openaiApiKey, { apiKey: KEY_A, keyHint: 'AAAA' })
    assert.equal((await second.keyringOps()).filter(op => op.action === 'store').length, storeOpsBefore, 'a restart must not rewrite the keyring')
    assert.equal(second.router.requests.length, 0, 'no chat may reach the router in the restarted session')
    await assertSecretNotLeaked(second, KEY_A)
  } finally {
    if (first && !first.exited) await first.stop().catch(() => {})
    await second?.stop()
    await openai.close()
  }
})

test('logout in a restarted session (model came from the saved default) still falls back to Verboo, and so does the next restart', { timeout: TEST_TIMEOUT }, async () => {
  const openai = await createFakeOpenAI(fakeOpenAI())
  let first, second, third
  try {
    first = await startSession({ openai })
    await first.waitForText('Describe a task')
    await connectKey(first, KEY_A)
    await pickOpenAIGpt55(first)
    await first.stop()

    second = await startSession({ reuse: first, openai })
    await second.waitForText('OpenAI openai-api/gpt-5.5')
    await second.submit('/openai logout')
    await second.waitForText(REMOVED)
    await second.waitForText('Verboo fixture-model')
    const chatsAtLogout = openai.chatRequests().length
    await say(second, 'TURN_SAME_SESSION', 'VERBOO_ANSWER TURN_SAME_SESSION')
    assert.equal(routerChats(second, 'TURN_SAME_SESSION').filter(body => body.tools?.length)[0].model, 'fixture-model')
    await second.stop()

    third = await startSession({ reuse: first, openai })
    await third.waitForText('Verboo fixture-model')
    assert.ok(!third.screenText().includes('openai-api'), `a removed key must not leave its model behind:\n${third.screen()}`)
    await say(third, 'TURN_NEXT_RESTART', 'VERBOO_ANSWER TURN_NEXT_RESTART')
    assert.equal(routerChats(third, 'TURN_NEXT_RESTART').filter(body => body.tools?.length)[0].model, 'fixture-model')
    assert.equal(openai.chatRequests().length, chatsAtLogout)
    assert.equal(openai.modelRequests().every(record => record.at <= third.frames[0].at), true, 'without a key the catalog is not requested')
  } finally {
    for (const cli of [first, second]) if (cli && !cli.exited) await cli.stop().catch(() => {})
    await third?.stop()
    await openai.close()
  }
})

// ---- Places a person ends up in by accident ---------------------------------

test('a machine without a keyring: the key is validated but refused with an explanation, never written in plain text', { timeout: TEST_TIMEOUT }, () => withSession({ openai: fakeOpenAI(), secureStorageError: true }, async cli => {
  await openLoginDialog(cli)
  await paste(cli, KEY_A)
  await settle()
  await cli.press('enter')
  await cli.waitFor(() => cli.openai.modelRequests().length >= 1, 60_000)
  await cli.waitFor(() => !cli.screenText().includes('Validando a chave') && /Chave:/.test(cli.screen()), 60_000)
  assert.ok(!cli.screenText().includes('Chave da OpenAI conectada'), `must not claim success without a place to keep the key:\n${cli.screen()}`)
  assert.match(cli.screenText(), /armazenamento|secure storage|keychain|keyring/i, `must explain why:\n${cli.screen()}`)
  assert.equal(await cli.readPlainTextCredentials(), null, 'no fallback to a plain-text credentials file')
  await assertSecretNotLeaked(cli, KEY_A)
}))

test('key typed on the command line by mistake: usage is shown, the key is not used, stored or kept in plain text', { timeout: TEST_TIMEOUT }, () => withSession({ openai: fakeOpenAI() }, async cli => {
  await cli.type(`/openai login ${KEY_A}`)
  await settle()
  await cli.press('enter')
  await cli.waitForText('Uso: /openai [login|status|logout]')
  assert.equal(cli.openai.requests.length, 0)
  assert.equal((await cli.readSecureStorage())?.openaiApiKey, undefined)
  await settle(1500)
  // What is on disk matters more than the echo of what the person typed themselves.
  const leaks = []
  for (const root of [cli.config, cli.home, cli.projectsDir]) {
    for (const file of await collectFiles(root)) if ((await readFile(file, 'latin1').catch(() => '')).includes(KEY_A)) leaks.push(file.replace(`${cli.dir}/`, ''))
  }
  assert.deepEqual(leaks, [], 'the key must not stay in plain text in history or transcripts')
}))

test('key revoked in the OpenAI dashboard mid-session: the error points at OpenAI, the Verboo session survives, a new key recovers', { timeout: TEST_TIMEOUT }, async () => {
  let revoked = false
  const responder = record => {
    if (revoked && record.headers.authorization === `Bearer ${KEY_A}`) return openaiErrors.invalidApiKey()
    return openaiResponder(record)
  }
  await withSession({ openai: fakeOpenAI({ responder }), secureStorage: { openaiApiKey: openaiApiKeyCredential(KEY_A) } }, async cli => {
    await cli.waitFor(() => cli.openai.modelRequests().length > 0, 60_000)
    await pickOpenAIGpt55(cli)
    await say(cli, 'TURN_STILL_VALID', 'OPENAI_ANSWER TURN_STILL_VALID')
    revoked = true

    const chatsBefore = cli.openai.chatRequests().length
    await cli.submit('TURN_REVOKED: say hello.')
    await cli.waitFor(() => cli.openai.chatRequests().length > chatsBefore, 60_000)
    await cli.waitFor(() => /401|OpenAI|chave|API key|login/i.test(cli.screenText().split('TURN_REVOKED').at(-1)), 60_000)
    await settle(1500)
    const afterPrompt = cli.screenText().split('TURN_REVOKED').at(-1)
    assert.match(afterPrompt, /OpenAI|openai/, `the error must say it is the OpenAI key:\n${cli.screen()}`)
    assert.match(afterPrompt, /\/openai login|chave/i, `the error must lead to /openai login:\n${cli.screen()}`)
    assert.doesNotMatch(afterPrompt, /Please run \/login|\/login\b/, `/login is the Verboo session, which is fine:\n${cli.screen()}`)
    assert.deepEqual(routerChats(cli, 'TURN_REVOKED'), [], 'no silent fallback to Verboo')

    await connectKey(cli, KEY_B)
    await say(cli, 'TURN_RECOVERED', 'OPENAI_ANSWER TURN_RECOVERED')
    assert.equal(mainChats(cli.openai, 'TURN_RECOVERED').at(-1).headers.authorization, `Bearer ${KEY_B}`)
  })
})

test('restart with a revoked key: the CLI opens on Verboo, says nothing misleading, and a new key brings the models back', { timeout: TEST_TIMEOUT }, async () => {
  const openai = await createFakeOpenAI(fakeOpenAI({ responder: record => record.headers.authorization === `Bearer ${KEY_A}` ? openaiErrors.invalidApiKey() : openaiResponder(record) }))
  try {
    await withSession({ openai, secureStorage: { openaiApiKey: openaiApiKeyCredential(KEY_A) }, globalConfig: { lastVerbooModel: 'openai-api/gpt-5.5' } }, async cli => {
      await cli.waitForText('Verboo fixture-model')
      await say(cli, 'TURN_ON_VERBOO', 'VERBOO_ANSWER TURN_ON_VERBOO')
      assert.equal(openai.chatRequests().length, 0)
      await connectKey(cli, KEY_B)
      await pickOpenAIGpt55(cli)
      await say(cli, 'TURN_NEW_KEY_WORKS', 'OPENAI_ANSWER TURN_NEW_KEY_WORKS')
      assert.equal(mainChats(openai, 'TURN_NEW_KEY_WORKS')[0].headers.authorization, `Bearer ${KEY_B}`)
    })
  } finally { await openai.close() }
})

test('headless -p --model openai-api/gpt-5.5 with a stored key reaches OpenAI with the bare id', { timeout: TEST_TIMEOUT }, async () => {
  const cli = await startCli({
    usePty: false, model: 'openai-api/gpt-5.5', slashCommands: true,
    openai: fakeOpenAI(), secureStorage: { openaiApiKey: openaiApiKeyCredential(KEY_A) },
    routerOptions: { models: ['fixture-model'] }, routerHandler: verbooRouter,
    args: ['-p', 'TURN_HEADLESS: say hello.'],
  })
  try {
    const { exitCode } = await cli.exit
    assert.equal(exitCode, 0, cli.raw)
    assert.ok(cli.raw.includes('OPENAI_ANSWER TURN_HEADLESS'), cli.raw)
    const main = mainChats(cli.openai, 'TURN_HEADLESS')
    assert.equal(main.length, 1)
    assert.equal(main[0].body.model, 'gpt-5.5')
    assert.equal(main[0].headers.authorization, `Bearer ${KEY_A}`)
    assert.equal(routerChats(cli, 'TURN_HEADLESS').length, 0)
  } finally { await cli.stop() }
})
