// Scenario: a person works in auto mode on their own OpenAI or Anthropic key, with
// the router's classifier role configured. The classifier must use that same
// account: nothing from the session reaches the router.
// Run: node --test --test-concurrency=1 scripts/e2e/human/auto-mode-own-key.e2e.mjs
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { startCli } from '../terminal.mjs'
import { isClassifierRequest } from './http.mjs'
import { claudeApiKeyCredential, openaiApiKeyCredential } from './keyring.mjs'

const TIMEOUT = 240_000
const OPTED_IN = { skipAutoPermissionPrompt: true, permissions: { defaultMode: 'auto' } }
const WITH_ROLE = { models: ['fixture-model', 'classifier-model'], agentModelRoles: { classifier: 'classifier-model' } }
const COMMAND = `node -e "require('fs').writeFileSync('own-key.txt','ran')"`
const DONE = 'OWN_KEY_DONE'
const VERDICT = { thinking: 'fixture', shouldBlock: false, reason: 'Fixture verdict' }
const BASH = { command: COMMAND, description: 'Create a file' }

async function assertClassifiedOnOwnAccount(cli, classifierCalls) {
  await cli.waitForText('Describe a task')
  await cli.submit('Create the file')
  await cli.waitForText(DONE, 90_000)
  assert.ok(existsSync(join(cli.project, 'own-key.txt')), 'the command must run')
  assert.equal(classifierCalls.length > 0, true, 'the classifier must run on the user\'s account')
  assert.deepEqual(cli.router.requests.filter(isClassifierRequest), [], 'no classifier call may reach the router')
  assert.deepEqual(cli.router.requests.filter(body => body.tools?.length), [], 'no turn may reach the router')
}

test('own OpenAI key: the classifier runs on the key', { timeout: TIMEOUT }, async () => {
  const classifierCalls = []
  let step = 0
  const responder = record => {
    if (record.path !== '/v1/chat/completions') return undefined
    if (isClassifierRequest(record.body)) {
      classifierCalls.push(record.body)
      return { finishReason: 'stop', toolCalls: [{ name: 'classify_result', arguments: VERDICT }] }
    }
    if (!record.body.tools?.length) return undefined
    step += 1
    return step === 1 ? { toolCalls: [{ name: 'Bash', arguments: BASH }] } : { text: DONE }
  }
  const cli = await startCli({
    columns: 120,
    rows: 40,
    skipPermissions: false,
    userSettings: OPTED_IN,
    routerOptions: WITH_ROLE,
    model: 'openai-api/gpt-5.5',
    openai: { responder },
    secureStorage: { openaiApiKey: openaiApiKeyCredential('sk-proj-ownkeyfixture00000000000000000000AAAA') },
  })
  try {
    await assertClassifiedOnOwnAccount(cli, classifierCalls)
    assert.equal(classifierCalls[0].model, 'gpt-5.5')
  } finally { await cli.stop() }
})

test('own Anthropic key: the classifier runs on the key', { timeout: TIMEOUT }, async () => {
  const classifierCalls = []
  let step = 0
  const responder = record => {
    if (record.path !== '/v1/messages') return undefined
    if (isClassifierRequest(record.body)) {
      classifierCalls.push(record.body)
      return { content: [{ type: 'tool_use', name: 'classify_result', input: VERDICT }] }
    }
    if (!record.body.tools?.length) return undefined
    step += 1
    return step === 1 ? { content: [{ type: 'tool_use', name: 'Bash', input: BASH }] } : { text: DONE }
  }
  const key = 'sk-ant-api03-ownkeyfixture0000000000000000000000BBBB'
  const credential = claudeApiKeyCredential(key)
  const cli = await startCli({
    columns: 120,
    rows: 40,
    skipPermissions: false,
    userSettings: OPTED_IN,
    routerOptions: WITH_ROLE,
    model: 'claude-sonnet-4-5-20250929',
    anthropic: { responder },
    secureStorage: { claudeNative: credential },
  })
  try {
    await assertClassifiedOnOwnAccount(cli, classifierCalls)
  } finally { await cli.stop() }
})
