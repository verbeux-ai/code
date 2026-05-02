import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

import { saveGlobalConfig } from '../config.js'

const SAVED_ENV = {
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
  ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
  ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  ANTHROPIC_SMALL_FAST_MODEL: process.env.ANTHROPIC_SMALL_FAST_MODEL,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  VERBOO_DEFAULT_MODEL: process.env.VERBOO_DEFAULT_MODEL,
}

async function importFreshModelModule(
  models: Array<{ id: string }> = [{ id: 'gpt-5.4' }],
) {
  mock.restore()
  mock.module('../../constants/oauth.js', () => ({
    isVerbooMode: () => true,
  }))
  mock.module('../../services/api/verbooModels.js', () => ({
    getCachedVerbooModels: () => models,
  }))
  const nonce = `${Date.now()}-${Math.random()}`
  return import(`./model.js?ts=${nonce}`)
}

function restoreEnv(key: keyof typeof SAVED_ENV): void {
  if (SAVED_ENV[key] === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = SAVED_ENV[key]
  }
}

beforeEach(() => {
  mock.restore()
  process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6'
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-4-6'
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-4-6'
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'claude-haiku-4-5'
  process.env.ANTHROPIC_SMALL_FAST_MODEL = 'claude-haiku-4-5'
  delete process.env.OPENAI_MODEL
  delete process.env.VERBOO_DEFAULT_MODEL
  saveGlobalConfig(current => ({ ...current, model: undefined }))
})

afterEach(() => {
  mock.restore()
  for (const key of Object.keys(SAVED_ENV) as Array<keyof typeof SAVED_ENV>) {
    restoreEnv(key)
  }
  saveGlobalConfig(current => ({ ...current, model: undefined }))
})

test('Verboo defaults never use Claude models from Claude Code env or subscription paths', async () => {
  const {
    getDefaultHaikuModel,
    getDefaultMainLoopModelSetting,
    getDefaultOpusModel,
    getDefaultSonnetModel,
    getSmallFastModel,
  } = await importFreshModelModule()

  expect(getDefaultMainLoopModelSetting()).toBe('gpt-5.4')
  expect(getDefaultOpusModel()).toBe('gpt-5.4')
  expect(getDefaultSonnetModel()).toBe('gpt-5.4')
  expect(getDefaultHaikuModel()).toBe('gpt-5.4')
  expect(getSmallFastModel()).toBe('gpt-5.4')
})

test('Verboo ignores Claude aliases and Claude model IDs from user settings', async () => {
  saveGlobalConfig(current => ({ ...current, model: 'sonnet' }))
  const { getUserSpecifiedModelSetting, parseUserSpecifiedModel } =
    await importFreshModelModule()

  expect(getUserSpecifiedModelSetting()).toBeUndefined()
  expect(parseUserSpecifiedModel('sonnet')).toBe('gpt-5.4')
  expect(parseUserSpecifiedModel('claude-sonnet-4-6')).toBe('gpt-5.4')
})

test('Verboo falls back to a non-Claude model when router cache is cold', async () => {
  process.env.OPENAI_MODEL = 'claude-sonnet-4-6'
  const { getDefaultMainLoopModelSetting } = await importFreshModelModule([])

  expect(getDefaultMainLoopModelSetting()).toBe('gpt-5.5')
})
