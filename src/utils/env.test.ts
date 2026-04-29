import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const originalEnv = {
  VERBOO_CONFIG_DIR: process.env.VERBOO_CONFIG_DIR,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CLAUDE_CODE_CUSTOM_OAUTH_URL: process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL,
  USER_TYPE: process.env.USER_TYPE,
}

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'verboo-env-test-'))
  process.env.VERBOO_CONFIG_DIR = tempDir
  process.env.CLAUDE_CONFIG_DIR = join(tmpdir(), 'ignored-claude-config')
  delete process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
  delete process.env.USER_TYPE
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
  if (originalEnv.VERBOO_CONFIG_DIR === undefined) {
    delete process.env.VERBOO_CONFIG_DIR
  } else {
    process.env.VERBOO_CONFIG_DIR = originalEnv.VERBOO_CONFIG_DIR
  }
  if (originalEnv.CLAUDE_CONFIG_DIR === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalEnv.CLAUDE_CONFIG_DIR
  }
  if (originalEnv.CLAUDE_CODE_CUSTOM_OAUTH_URL === undefined) {
    delete process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
  } else {
    process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = originalEnv.CLAUDE_CODE_CUSTOM_OAUTH_URL
  }
  if (originalEnv.USER_TYPE === undefined) {
    delete process.env.USER_TYPE
  } else {
    process.env.USER_TYPE = originalEnv.USER_TYPE
  }
})

async function importFreshEnvModule() {
  return import(`./env.js?ts=${Date.now()}-${Math.random()}`)
}

test('getGlobalClaudeFile: uses Verboo config home .config.json', async () => {
  const { getGlobalClaudeFile } = await importFreshEnvModule()
  expect(getGlobalClaudeFile()).toBe(join(tempDir, '.config.json'))
})

test('getGlobalClaudeFile: ignores legacy config files', async () => {
  writeFileSync(join(tempDir, '.claude.json'), '{}')
  writeFileSync(join(tempDir, '.openclaude.json'), '{}')
  const { getGlobalClaudeFile } = await importFreshEnvModule()
  expect(getGlobalClaudeFile()).toBe(join(tempDir, '.config.json'))
})
