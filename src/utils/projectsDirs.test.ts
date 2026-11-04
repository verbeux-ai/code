/**
 * VERBOO-BRAND: new sessions live under the Verboo config dir. Old sessions in
 * ~/.claude/projects are only read (for /resume) and copied before resuming.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  getAdditionalProjectsDirs,
  getProjectsDir,
  getProjectsDirs,
  setClaudeConfigHomeDirForTesting,
  setHomeDirForTesting,
} from './envUtils.js'
import { adoptReadOnlyTranscriptForResume, fetchLogs, saveCustomTitle } from './sessionStorage.js'
import { getOriginalCwd } from '../bootstrap/state.js'
import { sanitizePath } from './sessionStoragePortable.js'

const savedEnv = {
  VERBOO_CONFIG_DIR: process.env.VERBOO_CONFIG_DIR,
  VERBOO_PROJECTS_DIR: process.env.VERBOO_PROJECTS_DIR,
}
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'verboo-projects-'))
  // os.homedir() ignores HOME changes at runtime under Bun.
  setHomeDirForTesting(home)
  setClaudeConfigHomeDirForTesting(join(home, '.verboo'))
  delete process.env.VERBOO_CONFIG_DIR
  delete process.env.VERBOO_PROJECTS_DIR
})

afterEach(() => {
  setHomeDirForTesting(undefined)
  setClaudeConfigHomeDirForTesting(undefined)
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(home, { recursive: true, force: true })
})

test('new sessions go to the Verboo config dir, not ~/.claude', () => {
  expect(getProjectsDir()).toBe(join(home, '.verboo', 'projects'))
  expect(getProjectsDir()).not.toContain('.claude')
  process.env.VERBOO_PROJECTS_DIR = join(home, 'explicit')
  expect(getProjectsDir()).toBe(join(home, 'explicit'))
})

test('old ~/.claude/projects is a read-only source only when the install is not isolated', () => {
  const legacy = join(home, '.claude', 'projects')
  expect(getAdditionalProjectsDirs()).not.toContain(legacy)
  mkdirSync(legacy, { recursive: true })
  expect(getAdditionalProjectsDirs()).toContain(legacy)
  expect(getProjectsDirs()[0]).toBe(join(home, '.verboo', 'projects'))
  process.env.VERBOO_CONFIG_DIR = join(home, 'isolated')
  expect(getAdditionalProjectsDirs()).not.toContain(legacy)
})

test('resuming an old session copies it into the Verboo dir and leaves the original untouched', async () => {
  const legacyProject = join(home, '.claude', 'projects', '-work-app')
  mkdirSync(join(legacyProject, 'session-1', 'tool-results'), { recursive: true })
  const original = join(legacyProject, 'session-1.jsonl')
  writeFileSync(original, '{"type":"user"}\n')
  writeFileSync(join(legacyProject, 'session-1', 'tool-results', 'r.txt'), 'result')

  const resumeDir = await adoptReadOnlyTranscriptForResume(original)

  const copiedProject = join(home, '.verboo', 'projects', '-work-app')
  expect(resumeDir).toBe(copiedProject)
  expect(readFileSync(join(copiedProject, 'session-1.jsonl'), 'utf8')).toBe('{"type":"user"}\n')
  expect(readFileSync(join(copiedProject, 'session-1', 'tool-results', 'r.txt'), 'utf8')).toBe('result')
  expect(readFileSync(original, 'utf8')).toBe('{"type":"user"}\n')

  // A second resume keeps the copy (and anything appended to it).
  writeFileSync(join(copiedProject, 'session-1.jsonl'), '{"type":"user"}\n{"type":"assistant"}\n')
  expect(await adoptReadOnlyTranscriptForResume(original)).toBe(copiedProject)
  expect(readFileSync(join(copiedProject, 'session-1.jsonl'), 'utf8')).toContain('assistant')
})

test('a transcript already in the Verboo dir resumes in place', async () => {
  const project = join(home, '.verboo', 'projects', '-work-app')
  mkdirSync(project, { recursive: true })
  const transcript = join(project, 'session-2.jsonl')
  writeFileSync(transcript, '{}\n')
  expect(await adoptReadOnlyTranscriptForResume(transcript)).toBe(project)
  expect(existsSync(join(home, '.claude'))).toBe(false)
})

test('--resume <id> builds the path in the Verboo dir: the old session is still found and copied', async () => {
  const legacyProject = join(home, '.claude', 'projects', '-work-app')
  mkdirSync(legacyProject, { recursive: true })
  const original = join(legacyProject, 'session-3.jsonl')
  writeFileSync(original, '{"type":"user"}\n')

  const computed = join(home, '.verboo', 'projects', '-work-app', 'session-3.jsonl')
  expect(await adoptReadOnlyTranscriptForResume(computed)).toBe(join(home, '.verboo', 'projects', '-work-app'))
  expect(readFileSync(computed, 'utf8')).toBe('{"type":"user"}\n')
  expect(readFileSync(original, 'utf8')).toBe('{"type":"user"}\n')
})

test('a brand new session id stays in the Verboo dir without copying anything', async () => {
  const computed = join(home, '.verboo', 'projects', '-work-app', 'session-new.jsonl')
  expect(await adoptReadOnlyTranscriptForResume(computed)).toBe(join(home, '.verboo', 'projects', '-work-app'))
  expect(existsSync(computed)).toBe(false)
})

test('renaming an old session from the picker writes to its copy, never to the original', async () => {
  const legacyProject = join(home, '.claude', 'projects', '-work-app')
  mkdirSync(legacyProject, { recursive: true })
  const sessionId = '7f4e8a4e-5c0b-4a4e-9d0a-1a2b3c4d5e6f'
  const original = join(legacyProject, `${sessionId}.jsonl`)
  writeFileSync(original, '{"type":"user"}\n')

  await saveCustomTitle(sessionId as never, 'novo nome', original)

  expect(readFileSync(original, 'utf8')).toBe('{"type":"user"}\n')
  const copy = readFileSync(join(home, '.verboo', 'projects', '-work-app', `${sessionId}.jsonl`), 'utf8')
  expect(copy).toContain('novo nome')
})

test('--continue also considers sessions saved before the move, once each', async () => {
  const project = sanitizePath(getOriginalCwd())
  const sessionId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
  const entry = `${JSON.stringify({ type: 'user', sessionId, uuid: sessionId, message: { role: 'user', content: 'old prompt' } })}\n`
  for (const root of ['.claude', '.verboo']) {
    mkdirSync(join(home, root, 'projects', project), { recursive: true })
  }
  writeFileSync(join(home, '.claude', 'projects', project, `${sessionId}.jsonl`), entry)
  let logs = await fetchLogs()
  expect(logs.filter(log => log.sessionId === sessionId)).toHaveLength(1)

  writeFileSync(join(home, '.verboo', 'projects', project, `${sessionId}.jsonl`), entry)
  logs = await fetchLogs()
  const found = logs.filter(log => log.sessionId === sessionId)
  expect(found).toHaveLength(1)
  expect(found[0]?.fullPath).toContain(join('.verboo', 'projects'))
})
