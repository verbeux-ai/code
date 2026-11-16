// Scenario: an existing user logged in with a Claude Pro/Max subscription (and,
// long ago, with GitHub Copilot) and updates to a release where both are retired.
// Run: node --test --test-concurrency=1 scripts/e2e/human/retire-oauth.e2e.mjs
import assert from 'node:assert/strict'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { CODEX_FIXTURE_ACCOUNT, CODEX_FIXTURE_TOKEN } from '../codex-router.mjs'
import { REAL_USER_TRAFFIC_ENV, startCli } from '../terminal.mjs'
import { anthropicErrors } from './fake-anthropic.mjs'
import { sendChatCompletion } from './http.mjs'
import { claudeApiKeyCredential, claudeLegacyOAuthCredential, encodeSecureStoragePayload, githubModelsCredential } from './keyring.mjs'

const STALE_CLAUDE_MODEL = 'claude-sonnet-4-5-20250929'
const VERBOO_MODEL = 'fixture-model'
const VERBOO_REPLY = 'RETIRE_OAUTH_VERBOO_REPLY'

const OAUTH_ACCESS = 'fixture-retired-claude-oauth-access'
const OAUTH_REFRESH = 'fixture-claude-oauth-refresh' // what claudeLegacyOAuthCredential stores
const COPILOT_VAULT = 'fixture-retired-copilot-vault-token'
const COPILOT_PLAIN = 'fixture-retired-copilot-plain-token'
const RETIRED_SECRETS = [OAUTH_ACCESS, OAUTH_REFRESH, COPILOT_VAULT, COPILOT_PLAIN]
const API_KEY = 'sk-ant-api03-retirefixture0000000000000000000ZZZZ'
const BAD_API_KEY = 'sk-ant-api03-retirefixturerejected00000000000XXXX'

const CLAUDE_LOCAL_ID = 'claude-local-oauth'
const CODEX_LOCAL_ID = 'codex-local-1'

const NOTICE_START = 'Use /claude login:'
// The whole text, whitespace-normalized (src/utils/claudeLoginRetiredNotice.ts).
const NOTICE_FULL = /Use \/claude login: login antigo desativado\./
const CRASH_TEXT = /TypeError|SyntaxError|ReferenceError|Unhandled|ERR_|provider_storage|\bat .+\.m?js:\d+/

const normalize = text => text.replace(/\s+/g, ' ')
const everyFrame = cli => cli.frames.map(frame => frame.text)
const framesWith = (cli, text) => everyFrame(cli).filter(frame => normalize(frame).includes(text))

function oauthCredential(accountId = 'claude-subscriber') {
  return claudeLegacyOAuthCredential({ accessToken: OAUTH_ACCESS, accountId })
}

function codexCredential() {
  return { apiKey: CODEX_FIXTURE_TOKEN, accessToken: CODEX_FIXTURE_TOKEN, accountId: CODEX_FIXTURE_ACCOUNT }
}

function account(localAccountId, displayLabel, credential) {
  return { localAccountId, providerSubjectId: credential.accountId, displayLabel, credential, connectionState: 'connected' }
}

function codexCollection() {
  return { defaultAccountId: CODEX_LOCAL_ID, accounts: { [CODEX_LOCAL_ID]: account(CODEX_LOCAL_ID, 'Codex 1', codexCredential()) } }
}

/** The record a Claude Pro/Max + Codex + (old) Copilot user has in the OS keyring. */
function upgradingKeyring(overrides = {}) {
  const oauth = oauthCredential()
  return {
    verbooInstallationId: 'fixture-installation-kept',
    codex: codexCredential(),
    claudeNative: oauth,
    githubModels: githubModelsCredential(COPILOT_VAULT),
    providerAccounts: {
      schemaVersion: 1,
      codex: codexCollection(),
      claude: { defaultAccountId: CLAUDE_LOCAL_ID, accounts: { [CLAUDE_LOCAL_ID]: account(CLAUDE_LOCAL_ID, 'Claude 1', oauth) } },
    },
    ...overrides,
  }
}

/** Answers the main turn with text; side queries (no tools) keep the fixture default. */
function answerWith(text) {
  return async (req, body, res) => {
    if (req.pathname !== '/router/v1/chat/completions' || !body.tools?.length) return undefined
    await sendChatCompletion(res, body, { text })
    return true
  }
}

/** startCli options for the upgrading user: no --model flag, stale last model, Codex fixture on. */
function upgradingUser(options = {}) {
  return {
    columns: 120, rows: 40,
    model: null, slashCommands: true,
    anthropic: true, codexOptions: {},
    unsetEnv: ['OPENAI_MODEL'], // set by the Codex fixture; a real user has no such variable
    routerHandler: answerWith(VERBOO_REPLY),
    secureStorage: upgradingKeyring(),
    plainTextCredentials: { githubModels: githubModelsCredential(COPILOT_PLAIN) },
    globalConfig: { lastVerbooModel: STALE_CLAUDE_MODEL },
    ...options,
  }
}

const waitForPrompt = cli => cli.waitForText('Describe a task', 90_000)
const readGlobalConfig = async cli => JSON.parse(await readFile(join(cli.config, '.config.json'), 'utf8'))
const mainTurnRequests = cli => cli.router.requests.filter(body => body.tools?.length)

/** Types /exit like a person and waits for a clean exit. */
async function quit(cli) {
  await cli.submit('/exit')
  const result = await Promise.race([cli.exit, delay(30_000).then(() => null)])
  assert.ok(result, `/exit did not end the process:\n${cli.screen()}`)
  assert.equal(result.exitCode, 0, `exit code after /exit:\n${cli.screen()}`)
}

async function walkFiles(root) {
  const names = await readdir(root, { recursive: true }).catch(() => [])
  const files = []
  for (const name of names) {
    const path = join(root, name)
    if ((await stat(path).catch(() => null))?.isFile()) files.push(path)
  }
  return files
}

/** Every retired token must be gone from the keyring, the config dir, the debug log and the screen. */
async function assertRetiredSecretsGone(cli, secrets = RETIRED_SECRETS) {
  const leaks = []
  const check = (where, text) => { for (const secret of secrets) if (text.includes(secret)) leaks.push(`${where} still contains ${secret}`) }
  for (const entry of await cli.readKeyring()) check(`keyring ${entry.attributes.service}`, `${entry.raw}\n${JSON.stringify(entry.data)}`)
  for (const file of await walkFiles(cli.config)) check(file, await readFile(file, 'utf8').catch(() => ''))
  check('debug.log', await readFile(join(cli.runDir, 'debug.log'), 'utf8').catch(() => ''))
  check('terminal output', cli.raw)
  assert.deepEqual(leaks, [])
}

/** The Codex account the user had must come through untouched and stay the Codex default. */
function assertCodexIntact(stored) {
  const codex = stored.providerAccounts.codex
  assert.equal(codex.defaultAccountId, CODEX_LOCAL_ID, 'the Codex account must stay the default for Codex')
  assert.deepEqual(Object.keys(codex.accounts), [CODEX_LOCAL_ID])
  assert.equal(codex.accounts[CODEX_LOCAL_ID].credential.accessToken, CODEX_FIXTURE_TOKEN)
  assert.equal(codex.accounts[CODEX_LOCAL_ID].credential.accountId, CODEX_FIXTURE_ACCOUNT)
  assert.equal(codex.accounts[CODEX_LOCAL_ID].displayLabel, 'Codex 1')
  assert.equal(stored.codex?.accessToken, CODEX_FIXTURE_TOKEN, 'the Codex mirror must stay')
}

/** The picker's option lines only (not the banner or the footer). */
function pickerText(cli) {
  const lines = cli.screen().split('\n')
  const start = lines.findIndex(line => line.includes('Modelos disponíveis'))
  const end = lines.findIndex(line => line.includes('Enter to confirm'))
  assert.ok(start >= 0 && end > start, `the /model picker is not on screen:\n${cli.screen()}`)
  return lines.slice(start + 1, end).join('\n')
}

test('first start after the update: the one-time notice appears and is recorded as shown', { timeout: 180_000 }, async () => {
  const cli = await startCli(upgradingUser())
  try {
    await waitForPrompt(cli)
    await cli.waitForText(NOTICE_START, 30_000)
    const config = await readGlobalConfig(cli)
    assert.equal(typeof config.claudeSubscriptionLoginRetiredAt, 'number', 'the retirement must be recorded')
    assert.equal(config.claudeSubscriptionLoginRetiredNoticeShown, true)
    // Nobody may be told to do anything about the removed token on the provider side.
    assert.deepEqual(cli.anthropic.requests, [], 'retiring a login must not call the provider')
  } finally { await cli.stop() }
})

test('the notice wording is complete and points to /claude login (very wide terminal)', { timeout: 180_000 }, async () => {
  const cli = await startCli(upgradingUser({ columns: 320, rows: 40 }))
  try {
    await waitForPrompt(cli)
    await cli.waitForText(NOTICE_START, 30_000)
    assert.match(cli.screenText(), NOTICE_FULL)
  } finally { await cli.stop() }
})

test('the notice tells the user what to do on normal terminals: /claude login is readable at 120x40 and 80x24', { timeout: 240_000 }, async () => {
  const visible = {}
  for (const [columns, rows] of [[120, 40], [80, 24]]) {
    const cli = await startCli(upgradingUser({ columns, rows }))
    try {
      await waitForPrompt(cli)
      await cli.waitForText(NOTICE_START, 30_000)
      await delay(3_000)
      const line = cli.screen().split('\n').find(text => text.includes(NOTICE_START)) ?? ''
      visible[`${columns}x${rows}`] = { line: line.trim(), showsClaudeLogin: framesWith(cli, '/claude login').length > 0 }
    } finally { await cli.stop() }
  }
  assert.ok(Object.values(visible).every(size => size.showsClaudeLogin),
    `the one-time notice never shows "/claude login", and it is not shown again:\n${JSON.stringify(visible, null, 2)}`)
})

test('after exit: no Claude OAuth account or blob is left, the Codex account is intact and still the default', { timeout: 180_000 }, async () => {
  const cli = await startCli(upgradingUser())
  try {
    await waitForPrompt(cli)
    await cli.waitForText(NOTICE_START, 30_000)
    await quit(cli)

    const stored = await cli.readSecureStorage()
    assert.deepEqual(stored.providerAccounts.claude.accounts, {}, 'no Claude account may remain')
    assert.equal(stored.providerAccounts.claude.defaultAccountId, undefined, 'no dangling Claude default')
    assert.equal(stored.claudeNative, undefined, 'the legacy OAuth blob must be gone')
    assertCodexIntact(stored)
    assert.equal(stored.verbooInstallationId, 'fixture-installation-kept', 'unrelated fields must survive')
    assert.ok((await cli.keyringOps()).some(op => op.action === 'store'), 'the keyring must really have been rewritten')
    await assertRetiredSecretsGone(cli)
  } finally { await cli.stop() }
})

test('Codex keeps working after the purge: its catalog and a real turn use the stored account', { timeout: 180_000 }, async () => {
  const cli = await startCli(upgradingUser({ args: ['--effort', 'high'] }))
  try {
    await waitForPrompt(cli)
    await cli.waitFor(() => cli.codexRouter.catalogRequests.length > 0, 30_000)
    await cli.submit('/model gpt-5.5')
    await cli.waitForText('Modelo alterado para', 30_000)
    await cli.submit('CODEX_E2E_SIMPLE: Say exactly that the Codex transport answered.')
    await cli.waitForText('CODEX_E2E_SIMPLE_REPLY', 60_000)
    assert.deepEqual(cli.codexRouter.violations, [])
    assert.ok(cli.codexRouter.requests.some(record => record.currentUserPrompt.includes('CODEX_E2E_SIMPLE') && record.headers.accountId === CODEX_FIXTURE_ACCOUNT))
    assert.equal(mainTurnRequests(cli).length, 0, 'a Codex turn must not go to the Verboo router')
    assert.deepEqual(cli.anthropic.requests, [])
  } finally { await cli.stop() }
})

test('Copilot: the stored login is gone from the keyring and the plain-text file; everything else stays', { timeout: 180_000 }, async () => {
  const cli = await startCli(upgradingUser({
    plainTextCredentials: { fixtureSibling: 'plain-kept', githubModels: githubModelsCredential(COPILOT_PLAIN) },
  }))
  try {
    await waitForPrompt(cli)
    await quit(cli)

    const vault = await cli.readSecureStorage()
    assert.ok(!('githubModels' in vault), 'githubModels must be gone from the keyring')
    assert.equal(vault.verbooInstallationId, 'fixture-installation-kept')
    const plain = await cli.readPlainTextCredentials()
    assert.ok(!('githubModels' in plain), 'githubModels must be gone from .credentials.json')
    assert.equal(plain.fixtureSibling, 'plain-kept')
    const mode = (await stat(join(cli.config, '.credentials.json'))).mode & 0o777
    assert.equal(mode, 0o600, 'the plain-text file must stay private')
    await assertRetiredSecretsGone(cli)
    assert.deepEqual(await cli.browserOpens(), [], 'no sign-in flow may start')
  } finally { await cli.stop() }
})

test('the session runs on a Verboo model, not on the stale claude-* id', { timeout: 180_000 }, async () => {
  const cli = await startCli(upgradingUser())
  try {
    await waitForPrompt(cli)
    assert.match(cli.screenText(), new RegExp(`Verboo · ${VERBOO_MODEL}`), 'the banner must name the Verboo model')
    await cli.submit('Oi, tudo certo depois da atualização?')
    await cli.waitForText(VERBOO_REPLY, 60_000)

    assert.deepEqual([...new Set(mainTurnRequests(cli).map(body => body.model))], [VERBOO_MODEL])
    assert.ok(cli.router.requests.every(body => body.model !== STALE_CLAUDE_MODEL), 'no request may name the stale model')
    assert.deepEqual(cli.anthropic.requests, [], 'nothing may reach the provider without a key')
    assert.equal(framesWith(cli, STALE_CLAUDE_MODEL).length, 0, 'the stale id must never be displayed')
  } finally { await cli.stop() }
})

test('a second start shows no notice, changes nothing and still chats', { timeout: 240_000 }, async () => {
  const first = await startCli(upgradingUser())
  let second
  try {
    await waitForPrompt(first)
    await first.waitForText(NOTICE_START, 30_000)
    await quit(first)
    const before = await readGlobalConfig(first)
    const keyringBefore = await first.readSecureStorage()
    await first.stop()

    second = await startCli({
      reuse: first, columns: 120, rows: 40, model: null, slashCommands: true, anthropic: true, codexOptions: {}, unsetEnv: ['OPENAI_MODEL'],
      routerHandler: answerWith(VERBOO_REPLY),
    })
    await waitForPrompt(second)
    await delay(6_000) // on the first start it showed within a moment of the prompt
    assert.equal(framesWith(second, NOTICE_START).length, 0, `the notice came back:\n${second.screen()}`)

    await second.submit('Segunda sessão, tudo bem?')
    await second.waitForText(VERBOO_REPLY, 60_000)
    assert.deepEqual([...new Set(mainTurnRequests(second).map(body => body.model))], [VERBOO_MODEL])
    assert.equal(framesWith(second, NOTICE_START).length, 0)

    const after = await readGlobalConfig(second)
    assert.equal(after.claudeSubscriptionLoginRetiredAt, before.claudeSubscriptionLoginRetiredAt, 'the retirement date must not move')
    assert.equal(after.claudeSubscriptionLoginRetiredNoticeShown, true)
    const keyringAfter = await second.readSecureStorage()
    assert.deepEqual(keyringAfter.providerAccounts, keyringBefore.providerAccounts)
    assert.deepEqual(second.anthropic.requests, [])
  } finally {
    if (second) await second.stop()
    if (!first.exited) await first.stop().catch(() => {})
  }
})

test('/onboard-github is not a command: no suggestion, unknown when typed, absent from /help', { timeout: 240_000 }, async () => {
  const cli = await startCli(upgradingUser())
  try {
    await waitForPrompt(cli)

    // Control: autocomplete does work for a command that exists...
    await cli.type('/cla')
    await cli.waitForText('/claude', 30_000)
    await cli.press('ctrl-u')
    await delay(300)
    // ...and offers nothing for the retired one.
    const beforeTyping = cli.frames.length
    await cli.type('/onboard')
    await delay(2_000)
    assert.ok(!cli.frames.slice(beforeTyping).some(frame => frame.text.includes('onboard-github')), `the retired command was suggested:\n${cli.screen()}`)
    await cli.press('ctrl-u')
    await delay(300)

    const turnsBefore = mainTurnRequests(cli).length
    await cli.submit('/onboard-github')
    await cli.waitForText('Unknown skill: onboard-github', 30_000)
    await cli.submit('/onboard-github --force')
    await cli.waitForText('Args from unknown skill: --force', 30_000)
    assert.equal(mainTurnRequests(cli).length, turnsBefore, 'an unknown command must not go to the model')
    assert.deepEqual(await cli.browserOpens(), [], 'no device flow may open a browser')
    assert.deepEqual(await cli.networkLog(), [], 'no request to GitHub may leave')
    assert.ok(!(await cli.readSecureStorage()).githubModels, 'the token must not come back')

    // The user recovers: /help, commands tab, all the way down the list.
    await cli.submit('/help')
    await cli.waitForText('general', 30_000)
    const beforeHelp = cli.frames.length
    await cli.press('tab')
    await cli.waitForText('Browse default commands', 30_000)
    await cli.press('down', 150)
    await delay(1_000)
    const listed = cli.frames.slice(beforeHelp).map(frame => frame.text).join('\n')
    for (const name of ['/claude', '/codex', '/model', '/openai']) assert.ok(listed.includes(name), `${name} should be in /help (proves the list was scrolled)`)
    // The transcript still shows what the person typed; a list row carries a description.
    assert.doesNotMatch(listed, /\/onboard-github\s+\p{L}/u, '/help must not list /onboard-github')
    await cli.press('esc')
    await waitForPrompt(cli)
    await cli.submit('Ainda funciona?')
    await cli.waitForText(VERBOO_REPLY, 60_000)
  } finally { await cli.stop() }
})

test('/model lists Verboo and Codex models only; Claude ids typed by habit are refused', { timeout: 240_000 }, async () => {
  const cli = await startCli(upgradingUser())
  try {
    await waitForPrompt(cli)
    await cli.submit('/model')
    await cli.waitForText('Modelos disponíveis no Verboo Code', 30_000)
    const options = pickerText(cli)
    assert.match(options, /fixture-model/)
    assert.match(options, /gpt-5\.5/, 'the Codex account must keep its models')
    assert.doesNotMatch(options, /claude|sonnet|opus|haiku|via sua chave/i, 'no Claude option without a key')
    await cli.press('esc')
    await waitForPrompt(cli)

    // Muscle memory: the exact old id, then the short alias.
    await cli.submit(`/model ${STALE_CLAUDE_MODEL}`)
    await cli.waitForText(`O modelo '${STALE_CLAUDE_MODEL}' não está disponível`, 30_000)
    await cli.submit('/model sonnet')
    await cli.waitForText(`O modelo 'sonnet' não está disponível`, 30_000)

    // Refreshing does not bring them back either: 1 Verboo + 1 Codex.
    await cli.submit('/model refresh')
    await cli.waitForText('Catálogo atualizado: 2 modelo(s).', 30_000)
    assert.deepEqual(cli.anthropic.requests, [], 'no key, no catalog request')

    await cli.submit('Qual modelo está ativo?')
    await cli.waitForText(VERBOO_REPLY, 60_000)
    assert.deepEqual([...new Set(mainTurnRequests(cli).map(body => body.model))], [VERBOO_MODEL], 'the refused ids must not change the model')
    assert.notEqual((await readGlobalConfig(cli)).lastVerbooModel, 'sonnet')
  } finally { await cli.stop() }
})

test('Esc on the /model picker keeps the model and says so', { timeout: 180_000 }, async () => {
  const cli = await startCli(upgradingUser())
  try {
    await waitForPrompt(cli)
    await cli.submit('/model')
    await cli.waitForText('Modelos disponíveis no Verboo Code', 30_000)
    await cli.press('esc')
    await waitForPrompt(cli)
    await delay(1_000)
    assert.doesNotMatch(cli.screenText(), /Interrupted/, `nothing was running, so nothing was interrupted:\n${cli.screen()}`)
    assert.match(cli.screenText(), /Modelo mantido\./, 'the picker has its own cancel message')
  } finally { await cli.stop() }
})

test('both an OAuth login (default) and an API key: the key stays, becomes the default and keeps its models', { timeout: 240_000 }, async () => {
  const oauth = oauthCredential()
  const key = claudeApiKeyCredential(API_KEY)
  const cli = await startCli(upgradingUser({
    anthropic: { responder: record => record.path === '/v1/messages' && record.body?.tools?.length ? { text: 'RETIRE_OAUTH_KEY_REPLY' } : undefined },
    secureStorage: upgradingKeyring({
      claudeNative: oauth,
      providerAccounts: {
        schemaVersion: 1,
        codex: codexCollection(),
        claude: {
          defaultAccountId: CLAUDE_LOCAL_ID,
          accounts: { [CLAUDE_LOCAL_ID]: account(CLAUDE_LOCAL_ID, 'Claude 1', oauth), 'claude-local-key': account('claude-local-key', 'Claude 2', key) },
        },
      },
    }),
  }))
  try {
    await waitForPrompt(cli)
    await cli.waitForText(NOTICE_START, 30_000)

    // The catalog was loaded with the key, right after the OAuth login was removed.
    const catalog = cli.anthropic.modelRequests()[0]
    assert.ok(catalog, 'the key must still load the Claude catalog at startup')
    assert.equal(catalog.headers['x-api-key'], API_KEY)
    assert.equal(catalog.headers.authorization, undefined)

    await cli.submit('/claude status')
    await cli.waitForText('…ZZZZ', 30_000)
    await cli.submit('/model')
    await cli.waitForText('Modelos disponíveis no Verboo Code', 30_000)
    const options = pickerText(cli)
    assert.match(options, /Claude Sonnet 4\.5/)
    assert.match(options, /via sua chave/)
    assert.match(options, /fixture-model/)
    assert.match(options, /gpt-5\.5/)
    await cli.press('esc')
    await waitForPrompt(cli)

    // lastVerbooModel is in the key's catalog, so the session stays on it, through the key.
    await cli.submit('Ainda falo com o Claude pela minha chave?')
    await cli.waitForText('RETIRE_OAUTH_KEY_REPLY', 60_000)
    const main = cli.anthropic.messageRequests().find(record => record.body.tools?.length)
    assert.equal(main.body.model, STALE_CLAUDE_MODEL)
    assert.equal(main.headers['x-api-key'], API_KEY)
    assert.equal(main.headers.authorization, undefined, 'no OAuth bearer')
    assert.doesNotMatch(main.headers['anthropic-beta'] ?? '', /oauth/)
    assert.equal(mainTurnRequests(cli).length, 0, 'this turn belongs to the key, not to the router')

    await quit(cli)
    const stored = await cli.readSecureStorage()
    assert.deepEqual(Object.keys(stored.providerAccounts.claude.accounts), ['claude-local-key'])
    assert.equal(stored.providerAccounts.claude.defaultAccountId, 'claude-local-key', 'the key must become the default')
    assert.equal(stored.providerAccounts.claude.accounts['claude-local-key'].credential.apiKey, API_KEY)
    assert.equal(stored.claudeNative?.authType, 'api-key', 'the mirror must follow the new default')
    assert.equal(stored.claudeNative?.apiKey, API_KEY)
    assertCodexIntact(stored)
    await assertRetiredSecretsGone(cli)
    assert.ok(!cli.raw.includes(API_KEY), 'the key must never be displayed')
  } finally { await cli.stop() }
})

test('API key as default and an OAuth login on the side: the default does not move, the session stays on Verboo', { timeout: 180_000 }, async () => {
  const key = claudeApiKeyCredential(API_KEY)
  const cli = await startCli(upgradingUser({
    globalConfig: { lastVerbooModel: VERBOO_MODEL },
    secureStorage: upgradingKeyring({
      claudeNative: key,
      providerAccounts: {
        schemaVersion: 1,
        codex: codexCollection(),
        claude: {
          defaultAccountId: 'claude-local-key',
          accounts: { 'claude-local-key': account('claude-local-key', 'Claude 2', key), [CLAUDE_LOCAL_ID]: account(CLAUDE_LOCAL_ID, 'Claude 1', oauthCredential()) },
        },
      },
    }),
  }))
  try {
    await waitForPrompt(cli)
    await cli.waitForText(NOTICE_START, 30_000)
    await cli.submit('Oi')
    await cli.waitForText(VERBOO_REPLY, 60_000)
    assert.deepEqual([...new Set(mainTurnRequests(cli).map(body => body.model))], [VERBOO_MODEL])
    await quit(cli)
    const stored = await cli.readSecureStorage()
    assert.deepEqual(Object.keys(stored.providerAccounts.claude.accounts), ['claude-local-key'])
    assert.equal(stored.providerAccounts.claude.defaultAccountId, 'claude-local-key')
    assert.equal(stored.claudeNative?.apiKey, API_KEY)
    await assertRetiredSecretsGone(cli)
  } finally { await cli.stop() }
})

test('a user with only an API key sees no notice and loses nothing', { timeout: 180_000 }, async () => {
  const key = claudeApiKeyCredential(API_KEY)
  const cli = await startCli(upgradingUser({
    globalConfig: { lastVerbooModel: VERBOO_MODEL },
    plainTextCredentials: undefined,
    secureStorage: {
      codex: codexCredential(),
      claudeNative: key,
      providerAccounts: {
        schemaVersion: 1,
        codex: codexCollection(),
        claude: { defaultAccountId: 'claude-local-key', accounts: { 'claude-local-key': account('claude-local-key', 'Claude 1', key) } },
      },
    },
  }))
  try {
    await waitForPrompt(cli)
    await cli.waitFor(() => cli.anthropic.modelRequests().length > 0, 30_000)
    await delay(5_000)
    assert.equal(framesWith(cli, NOTICE_START).length, 0, `no OAuth login, no notice:\n${cli.screen()}`)
    await quit(cli)
    const stored = await cli.readSecureStorage()
    assert.deepEqual(Object.keys(stored.providerAccounts.claude.accounts), ['claude-local-key'])
    assert.equal(stored.claudeNative?.apiKey, API_KEY)
    assert.equal((await readGlobalConfig(cli)).claudeSubscriptionLoginRetiredAt, undefined)
  } finally { await cli.stop() }
})

test('an old install with only the legacy blobs (no providerAccounts): OAuth removed, Codex migrated or kept', { timeout: 180_000 }, async () => {
  const cli = await startCli(upgradingUser({
    secureStorage: { codex: codexCredential(), claudeNative: oauthCredential(), githubModels: githubModelsCredential(COPILOT_VAULT) },
  }))
  try {
    await waitForPrompt(cli)
    await cli.waitForText(NOTICE_START, 30_000)
    await cli.submit('Oi')
    await cli.waitForText(VERBOO_REPLY, 60_000)
    await quit(cli)
    const stored = await cli.readSecureStorage()
    assert.equal(stored.claudeNative, undefined)
    assert.equal(stored.githubModels, undefined)
    assert.deepEqual(stored.providerAccounts?.claude?.accounts ?? {}, {})
    assert.equal(stored.codex?.accessToken, CODEX_FIXTURE_TOKEN, 'the legacy Codex login must survive')
    await assertRetiredSecretsGone(cli)
  } finally { await cli.stop() }
})

test('the vault is locked on the first start: no crash, no false notice; the next start finishes the job', { timeout: 240_000 }, async () => {
  const first = await startCli(upgradingUser({ codexOptions: undefined, secureStorageError: true }))
  let second
  try {
    await waitForPrompt(first)
    await delay(4_000)
    assert.equal(framesWith(first, NOTICE_START).length, 0, 'nothing was removed, so nothing can be announced')
    await first.submit('Oi com o chaveiro travado')
    await first.waitForText(VERBOO_REPLY, 60_000)
    assert.doesNotMatch(cli_screen(first), CRASH_TEXT)
    // The plain-text copy does not depend on the vault.
    assert.ok(!('githubModels' in (await first.readPlainTextCredentials())), 'the plain-text token is purged even with the vault locked')
    assert.equal((await readGlobalConfig(first)).claudeSubscriptionLoginRetiredAt, undefined)
    await quit(first)
    assert.equal((await first.readSecureStorage()).claudeNative?.accessToken, OAUTH_ACCESS, 'a locked vault cannot be rewritten')
    await first.stop()

    second = await startCli({
      reuse: first, columns: 120, rows: 40, model: null, slashCommands: true, anthropic: true, routerHandler: answerWith(VERBOO_REPLY),
      codexOptions: {}, unsetEnv: ['OPENAI_MODEL'],
    })
    await waitForPrompt(second)
    await second.waitForText(NOTICE_START, 30_000)
    await quit(second)
    const stored = await second.readSecureStorage()
    assert.deepEqual(stored.providerAccounts.claude.accounts, {})
    assert.equal(stored.claudeNative, undefined)
    assert.equal(stored.githubModels, undefined)
    await assertRetiredSecretsGone(second)
  } finally {
    if (second) await second.stop()
    if (!first.exited) await first.stop().catch(() => {})
  }
})

test('headless -p first: the login is removed silently; the first interactive start shows the notice', { timeout: 240_000 }, async () => {
  const headless = await startCli(upgradingUser({ args: ['-p', 'Oi do modo headless'], slashCommands: false }))
  let interactive
  try {
    const { exitCode } = await Promise.race([headless.exit, delay(90_000).then(() => ({ exitCode: 'timeout' }))])
    assert.equal(exitCode, 0, headless.raw)
    assert.ok(headless.raw.includes(VERBOO_REPLY), 'the headless turn must run on Verboo')
    assert.ok(!normalize(headless.raw).includes(NOTICE_START), 'scripted output must stay clean')
    assert.deepEqual([...new Set(mainTurnRequests(headless).map(body => body.model))], [VERBOO_MODEL])
    const stored = await headless.readSecureStorage()
    assert.deepEqual(stored.providerAccounts.claude.accounts, {})
    assert.equal(stored.claudeNative, undefined)
    assert.equal(stored.githubModels, undefined)
    const config = await readGlobalConfig(headless)
    assert.equal(typeof config.claudeSubscriptionLoginRetiredAt, 'number')
    assert.ok(!config.claudeSubscriptionLoginRetiredNoticeShown, 'the notice is still owed')
    await headless.stop()

    interactive = await startCli({
      reuse: headless, columns: 120, rows: 40, model: null, slashCommands: true, anthropic: true, routerHandler: answerWith(VERBOO_REPLY),
      codexOptions: {}, unsetEnv: ['OPENAI_MODEL'],
    })
    await waitForPrompt(interactive)
    await interactive.waitForText(NOTICE_START, 30_000)
  } finally {
    if (interactive) await interactive.stop()
    if (!headless.exited) await headless.stop().catch(() => {})
  }
})

test('old Copilot settings (env written by the former /onboard-github) do not take the session away from Verboo', { timeout: 180_000 }, async () => {
  const cli = await startCli(upgradingUser({
    userSettings: { env: { CLAUDE_CODE_USE_GITHUB: '1', OPENAI_MODEL: 'github:copilot' } },
  }))
  try {
    await waitForPrompt(cli)
    await cli.waitForText(NOTICE_START, 30_000)
    assert.match(cli.screenText(), new RegExp(`Verboo · ${VERBOO_MODEL}`), `the banner must stay on Verboo:\n${cli.screen()}`)
    await cli.submit('Oi, voltei depois de um tempo')
    await cli.waitForText(VERBOO_REPLY, 60_000)
    assert.deepEqual([...new Set(mainTurnRequests(cli).map(body => body.model))], [VERBOO_MODEL])
    assert.deepEqual(await cli.networkLog(), [], 'nothing may go to GitHub')
    assert.doesNotMatch(cli.screenText(), /onboard-github|Copilot/, 'no pointer to a command that no longer exists')
    await quit(cli)
    assert.equal((await cli.readSecureStorage()).githubModels, undefined)
    assert.ok(!('githubModels' in (await cli.readPlainTextCredentials())))
  } finally { await cli.stop() }
})

test('following the notice: /claude login with a typo, then a rejected key, then a good one; Codex untouched', { timeout: 240_000 }, async () => {
  const cli = await startCli(upgradingUser({ globalConfig: { lastVerbooModel: VERBOO_MODEL } }))
  try {
    await waitForPrompt(cli)
    await cli.submit('/claude status')
    await cli.waitForText('Claude não conectado', 30_000)
    await cli.submit('/claude login')
    await cli.waitForText('Conectar Claude com sua chave de API', 30_000)

    // A person pastes the wrong thing first.
    await cli.submit('minha-senha-do-claude')
    await cli.waitForText('Isso não parece uma chave de API', 30_000)
    assert.deepEqual(cli.anthropic.modelRequests(), [], 'an obvious typo must not be sent anywhere')
    await cli.press('backspace', 'minha-senha-do-claude'.length)

    // Then a revoked key.
    cli.anthropic.enqueue(anthropicErrors.unauthorized(), { path: '/v1/models', method: 'GET' })
    await cli.submit(BAD_API_KEY)
    await cli.waitForText('recusou essa chave', 30_000)
    assert.equal(cli.anthropic.modelRequests().at(-1).headers['x-api-key'], BAD_API_KEY)
    assert.equal((await cli.readSecureStorage()).claudeNative, undefined, 'a rejected key must not be stored')
    await cli.press('backspace', BAD_API_KEY.length)

    // And the right one.
    await cli.submit(API_KEY)
    await cli.waitForText('Chave da Anthropic conectada (…ZZZZ)', 30_000)
    assert.ok(!cli.raw.includes(API_KEY), 'the key must be masked on screen')

    await cli.submit('/model')
    await cli.waitForText('Modelos disponíveis no Verboo Code', 30_000)
    assert.match(pickerText(cli), /Claude Sonnet 4\.5/)
    await cli.press('esc')
    await waitForPrompt(cli)
    await quit(cli)

    const stored = await cli.readSecureStorage()
    const accounts = Object.values(stored.providerAccounts.claude.accounts)
    assert.equal(accounts.length, 1)
    assert.equal(accounts[0].credential.authType, 'api-key')
    assert.equal(stored.providerAccounts.claude.defaultAccountId, accounts[0].localAccountId)
    assert.equal(stored.claudeNative?.apiKey, API_KEY)
    assertCodexIntact(stored)
    await assertRetiredSecretsGone(cli)
    const plain = await cli.readPlainTextCredentials()
    assert.ok(!JSON.stringify(plain ?? {}).includes(API_KEY), 'the key lives only in secure storage')
  } finally { await cli.stop() }
})

test('real-user traffic: the retired tokens are never sent anywhere, and no refresh is attempted', { timeout: 180_000 }, async () => {
  const cli = await startCli(upgradingUser({
    plugins: true,
    unsetEnv: ['OPENAI_MODEL', ...REAL_USER_TRAFFIC_ENV],
    // Known entries reported separately by the harness author; they stay blocked and logged.
    allowedNetwork: [/\/api\/me\/feedback\/next/, /^GET https:\/\/api\.github\.com\/repos\/verbeux-ai\/code\/releases$/, /^anthropic: GET \/mcp-registry\/v0\/servers/],
  }))
  try {
    await waitForPrompt(cli)
    await cli.submit('Oi')
    await cli.waitForText(VERBOO_REPLY, 60_000)
    await delay(8_000)

    const log = await cli.networkLog()
    assert.ok(!log.some(line => /oauth|\/token|console\.anthropic\.com|platform\.claude\.com|claude\.ai|githubcopilot|github\.com\/login/i.test(line)), `no login traffic expected:\n${log.join('\n')}`)
    const anthropic = cli.anthropic.requests
    assert.deepEqual(anthropic.filter(record => record.path !== '/mcp-registry/v0/servers').map(record => record.path), [], 'only the known registry call may reach the provider')
    for (const record of anthropic) {
      assert.equal(record.headers.authorization, undefined)
      assert.equal(record.headers['x-api-key'], undefined)
    }
    const sent = JSON.stringify([cli.router.allRequests.map(record => record.headers), cli.codexProxy?.requests ?? [], anthropic.map(record => record.headers)])
    for (const secret of RETIRED_SECRETS) assert.ok(!sent.includes(secret), 'a retired token was sent')
  } finally { await cli.stop() }
})

// ---- Corrupted keyring payloads ----

/** Starts the CLI with `raw` as the exact bytes stored in the keyring record. */
async function startWithRawKeyring(raw, options = {}) {
  // A run killed before it does anything creates the entry (the file name is the harness's own).
  const seed = await startCli({ secureStorage: { fixtureSeed: true } })
  await seed.stop()
  const names = (await readdir(seed.keyringDir)).filter(name => name.endsWith('.secret'))
  assert.equal(names.length, 1)
  const secretPath = join(seed.keyringDir, names[0])
  await writeFile(secretPath, raw)
  const cli = await startCli({
    reuse: seed, columns: 120, rows: 40, model: null, slashCommands: true, anthropic: true,
    routerHandler: answerWith(VERBOO_REPLY),
    globalConfig: { lastVerbooModel: STALE_CLAUDE_MODEL },
    ...options,
  })
  return { cli, secretPath }
}

function cli_screen(cli) { return `${cli.screen()}\n${cli.raw}` }

const validPayload = encodeSecureStoragePayload(upgradingKeyring())
const CORRUPTIONS = [
  ['plain garbage', 'this is not a credentials record {{{'],
  ['undecodable compressed payload', 'verboo-secure-v1:!!!not-base64-at-all!!!'],
  // KWallet's adapter silently truncates long secrets, which is why the payload is compressed at all.
  ['a compressed payload cut in half', validPayload.slice(0, Math.floor(validPayload.length / 2))],
  ['valid JSON of the wrong shape', JSON.stringify({ providerAccounts: 'oops', claudeNative: 42, codex: [], githubModels: 'x' })],
  ['a JSON value that is not an object', '12345'],
]

for (const [name, raw] of CORRUPTIONS) {
  test(`corrupted keyring (${name}): startup does not crash, and the user can chat on Verboo`, { timeout: 180_000 }, async () => {
    const { cli } = await startWithRawKeyring(raw)
    try {
      await waitForPrompt(cli)
      await delay(2_000)
      assert.equal(framesWith(cli, NOTICE_START).length, 0, 'nothing was removed, so there is nothing to announce')
      assert.doesNotMatch(cli_screen(cli), CRASH_TEXT, 'no stack trace or internal code on screen')
      await cli.submit('Oi, o chaveiro está estranho')
      await cli.waitForText(VERBOO_REPLY, 60_000)
      assert.deepEqual([...new Set(mainTurnRequests(cli).map(body => body.model))], [VERBOO_MODEL])
      assert.deepEqual(cli.anthropic.requests, [])
      await quit(cli)
    } finally { await cli.stop() }
  })
}

test('a record from a newer writer (unknown providerAccounts schema) is not destroyed; the legacy OAuth blob still goes', { timeout: 180_000 }, async () => {
  const futureAccounts = { schemaVersion: 99, claude: { accounts: { keep: { note: 'from a newer version' } } } }
  const { cli } = await startWithRawKeyring(encodeSecureStoragePayload({ providerAccounts: futureAccounts, claudeNative: oauthCredential(), codex: { accessToken: 'unused-by-this-test' } }))
  try {
    await waitForPrompt(cli)
    await cli.waitForText(NOTICE_START, 30_000)
    await cli.submit('Oi')
    await cli.waitForText(VERBOO_REPLY, 60_000)
    await quit(cli)
    const stored = await cli.readSecureStorage()
    assert.deepEqual(stored.providerAccounts, futureAccounts, 'accounts written by a newer version must survive')
    assert.equal(stored.claudeNative, undefined)
  } finally { await cli.stop() }
})

test('corrupted keyring: /claude status and /claude login explain the problem instead of crashing', { timeout: 180_000 }, async () => {
  const { cli, secretPath } = await startWithRawKeyring('this is not a credentials record {{{')
  try {
    await waitForPrompt(cli)
    await cli.submit('/claude status')
    await cli.waitForText('armazenamento seguro', 30_000)
    await cli.submit('/claude login')
    await cli.waitForText('Conectar Claude com sua chave de API', 30_000)
    await cli.submit(API_KEY)
    // Either the key is stored, or the person is told in plain words why it could not be.
    await cli.waitFor(() => /conectada|armazenamento seguro|chaveiro|provider_storage/.test(cli.screenText()) && !/Validando a chave/.test(cli.screenText()), 30_000)
    await delay(500)
    const screen = cli.screenText()
    assert.doesNotMatch(screen, /provider_storage_\w+/, `an internal error code is not an explanation:\n${cli.screen()}`)
    assert.ok(!cli.raw.includes(API_KEY), 'the key must stay masked')
    assert.ok(secretPath)
  } finally { await cli.stop() }
})
