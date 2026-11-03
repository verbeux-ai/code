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
import { adoptReadOnlyTranscriptForResume } from './sessionStorage.js'

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
