// Scenario: a user with sessions saved by an older release (in ~/.claude/projects)
// updates and keeps working. Old files are only read; new writes go to ~/.verboo.
// Run: node --test --test-concurrency=1 scripts/e2e/human/storage-resume.e2e.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { startCli } from '../terminal.mjs'

const OLD_SESSION = '11111111-2222-4333-8444-555555555555'
const OLD_PROMPT = 'LEGACY_FIRST_PROMPT'
const OLD_ANSWER = 'LEGACY_FIRST_ANSWER'
const REAL_LAYOUT = { slashCommands: true, unsetEnv: ['VERBOO_CONFIG_DIR', 'VERBOO_PROJECTS_DIR'] }

const sanitize = path => path.replace(/[^a-zA-Z0-9]/g, '-')
const waitForPrompt = cli => cli.waitForText('Describe a task', 90_000)

async function quit(cli) {
  await cli.submit('/exit')
  const result = await Promise.race([cli.exit, delay(30_000).then(() => null)])
  assert.ok(result, `/exit did not end the process:\n${cli.screen()}`)
}

function oldTranscript(cwd) {
  const base = {
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd,
    sessionId: OLD_SESSION,
    version: '0.15.41',
  }
  const user = '21111111-2222-4333-8444-555555555555'
  const assistant = '31111111-2222-4333-8444-555555555555'
  return [
    {
      ...base,
      type: 'user',
      uuid: user,
      timestamp: '2026-10-01T10:00:00.000Z',
      message: { role: 'user', content: OLD_PROMPT },
    },
    {
      ...base,
      parentUuid: user,
      type: 'assistant',
      uuid: assistant,
      timestamp: '2026-10-01T10:00:05.000Z',
      message: {
        id: 'msg_old',
        type: 'message',
        role: 'assistant',
        model: 'fixture-model',
        content: [{ type: 'text', text: OLD_ANSWER }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ]
    .map(entry => JSON.stringify(entry))
    .join('\n')
    .concat('\n')
}

/** Everything under a directory, as path -> content hash. */
async function snapshot(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])
  const files = {}
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    files[path] = createHash('sha256').update(await readFile(path)).digest('hex')
  }
  return files
}

/** A user who ran the older release in this project, restarting on the new one. */
async function withOldSession(options) {
  const first = await startCli(REAL_LAYOUT)
  try {
    await waitForPrompt(first)
    await quit(first)
  } finally { await first.stop() }
  const projectName = sanitize(await realpath(first.cwd))
  const oldDir = join(first.home, '.claude', 'projects', projectName)
  await mkdir(oldDir, { recursive: true })
  const oldFile = join(oldDir, `${OLD_SESSION}.jsonl`)
  await writeFile(oldFile, oldTranscript(await realpath(first.cwd)))
  const before = await snapshot(join(first.home, '.claude'))
  const cli = await startCli({ ...REAL_LAYOUT, reuse: first, ...options })
  const copy = join(first.home, '.verboo', 'projects', projectName, `${OLD_SESSION}.jsonl`)
  return {
    cli,
    copy,
    assertOldFilesUntouched: async () =>
      assert.deepEqual(await snapshot(join(first.home, '.claude')), before, '~/.claude must not change'),
  }
}

const lastRequestText = cli => JSON.stringify(cli.router.requests.filter(body => body.tools?.length).at(-1) ?? {})

async function runHeadless(options) {
  const scenario = await withOldSession({ usePty: false, ...options })
  const { exitCode } = await scenario.cli.exit
  assert.equal(exitCode, 0, scenario.cli.raw)
  return scenario
}

test('a new session is saved in ~/.verboo and nothing appears in ~/.claude', { timeout: 180_000 }, async () => {
  const cli = await startCli(REAL_LAYOUT)
  try {
    await waitForPrompt(cli)
    await cli.submit('NEW_SESSION_PROMPT')
    await cli.waitFor(() => cli.router.requests.some(body => JSON.stringify(body).includes('NEW_SESSION_PROMPT')), 60_000)
    await quit(cli)
    const saved = await snapshot(join(cli.home, '.verboo', 'projects'))
    assert.ok(Object.keys(saved).some(path => path.endsWith('.jsonl')), 'the session must be saved under ~/.verboo/projects')
    await assert.rejects(stat(join(cli.home, '.claude', 'projects')), 'no ~/.claude/projects may be created')
  } finally { await cli.stop() }
})

test('--continue finds a session from before the update and works on a copy', { timeout: 240_000 }, async () => {
  const { cli, copy, assertOldFilesUntouched } = await withOldSession({ args: ['--continue'] })
  try {
    await waitForPrompt(cli)
    await cli.waitForText(OLD_ANSWER, 30_000)
    await cli.submit('CONTINUE_PROMPT')
    await cli.waitFor(() => lastRequestText(cli).includes('CONTINUE_PROMPT'), 60_000)
    assert.ok(lastRequestText(cli).includes(OLD_PROMPT), 'the model must see the old history')
    await quit(cli)
    const copied = await readFile(copy, 'utf8')
    assert.ok(copied.includes(OLD_PROMPT) && copied.includes('CONTINUE_PROMPT'))
    await assertOldFilesUntouched()
  } finally { await cli.stop() }
})

test('--resume <id> keeps the old history across two restarts', { timeout: 300_000 }, async () => {
  const { cli, copy, assertOldFilesUntouched } = await withOldSession({ args: ['--resume', OLD_SESSION] })
  let second
  try {
    await waitForPrompt(cli)
    await cli.submit('SECOND_PROMPT')
    await cli.waitFor(() => lastRequestText(cli).includes('SECOND_PROMPT'), 60_000)
    await quit(cli)
    await cli.stop()

    second = await startCli({ ...REAL_LAYOUT, reuse: cli, args: ['--resume', OLD_SESSION] })
    await waitForPrompt(second)
    await second.submit('THIRD_PROMPT')
    await second.waitFor(() => lastRequestText(second).includes('THIRD_PROMPT'), 60_000)
    const sent = lastRequestText(second)
    assert.ok(sent.includes(OLD_PROMPT), 'the first prompt from the old release must still be there')
    assert.ok(sent.includes('SECOND_PROMPT'))
    await quit(second)
    assert.ok((await readFile(copy, 'utf8')).includes('THIRD_PROMPT'))
    await assertOldFilesUntouched()
  } finally {
    await second?.stop()
    await cli.stop()
  }
})

test('just opening an old session and quitting does not change it', { timeout: 180_000 }, async () => {
  const { cli, assertOldFilesUntouched } = await withOldSession({ args: ['--resume', OLD_SESSION] })
  try {
    await waitForPrompt(cli)
    await cli.waitForText(OLD_ANSWER, 30_000)
    await quit(cli)
    await assertOldFilesUntouched()
  } finally { await cli.stop() }
})

test('the /resume picker opens an old session from a copy', { timeout: 240_000 }, async () => {
  const { cli, copy, assertOldFilesUntouched } = await withOldSession({ slashCommands: true })
  try {
    await waitForPrompt(cli)
    await cli.submit('/resume')
    await cli.waitForText(OLD_PROMPT, 30_000)
    await cli.press('enter')
    await cli.waitForText(OLD_ANSWER, 30_000)
    await cli.submit('PICKER_PROMPT')
    await cli.waitFor(() => lastRequestText(cli).includes('PICKER_PROMPT'), 60_000)
    assert.ok(lastRequestText(cli).includes(OLD_PROMPT))
    await quit(cli)
    assert.ok((await readFile(copy, 'utf8')).includes('PICKER_PROMPT'))
    await assertOldFilesUntouched()
  } finally { await cli.stop() }
})

for (const [name, flags] of [
  ['-p --resume <id>', ['--resume', OLD_SESSION]],
  ['-p --continue', ['--continue']],
]) {
  test(`${name} uses the old history and leaves the original alone`, { timeout: 180_000 }, async () => {
    const { cli, copy, assertOldFilesUntouched } = await runHeadless({ args: ['-p', ...flags, 'HEADLESS_PROMPT'] })
    try {
      assert.ok(lastRequestText(cli).includes(OLD_PROMPT), 'the old history must reach the model')
      assert.ok((await readFile(copy, 'utf8')).includes('HEADLESS_PROMPT'))
      await assertOldFilesUntouched()
    } finally { await cli.stop() }
  })
}
