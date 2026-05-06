import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { VERBOO_ROUTER_URL } from '../constants/oauth.js'
import { detectProvider } from './StartupScreen.js'
import { saveGlobalConfig } from '../utils/config.js'
import {
  resetSettingsCache,
  setSessionSettingsCache,
} from '../utils/settings/settingsCache.js'

const ENV_KEYS = [
  'CI',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_MISTRAL',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'GEMINI_MODEL',
  'MISTRAL_MODEL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'CLAUDE_MODEL',
  'NVIDIA_NIM',
  'MINIMAX_API_KEY',
  'XAI_API_KEY',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_BASE_URL',
]

const originalEnv: Record<string, string | undefined> = {}
const originalMacro = (globalThis as Record<string, unknown>).MACRO
const originalIsTTY = process.stdout.isTTY
const originalWrite = process.stdout.write

async function importStartupScreenWithModels(
  models: Array<{ id: string }> = [{ id: 'early-adopters/qwen3.6-27b' }],
  settingsModel?: string,
) {
  mock.restore()
  setSessionSettingsCache({
    settings: settingsModel ? { model: settingsModel } : {},
    errors: [],
  })
  mock.module('../constants/oauth.js', () => ({
    VERBOO_ROUTER_URL,
    isVerbooMode: () => true,
  }))
  mock.module('../services/api/verbooModels.js', () => ({
    getCachedVerbooModels: () => models,
    getVerbooModelMeta: (modelId: string) =>
      models.find(model => model.id === modelId),
  }))
  const nonce = `${Date.now()}-${Math.random()}`
  return import(`./StartupScreen.js?ts=${nonce}`)
}

beforeEach(() => {
  mock.restore()
  resetSettingsCache()
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key]
    delete process.env[key]
  }
  setSessionSettingsCache({ settings: {}, errors: [] })
  saveGlobalConfig(current => ({
    ...current,
    model: undefined,
  }))
})

afterEach(() => {
  mock.restore()
  resetSettingsCache()
  saveGlobalConfig(current => ({
    ...current,
    model: undefined,
  }))
  ;(globalThis as Record<string, unknown>).MACRO = originalMacro
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value: originalIsTTY,
  })
  process.stdout.write = originalWrite
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = originalEnv[key]
    }
  }
})

describe('detectProvider — Verboo isolation', () => {
  test('uses Verboo router by default', async () => {
    const { detectProvider } = await importStartupScreenWithModels()

    const result = detectProvider()

    expect(result.name).toBe('Verboo')
    expect(result.baseUrl).toBe(VERBOO_ROUTER_URL)
    expect(result.model).not.toContain('claude')
  })

  test('ignores stale Claude model env vars', async () => {
    const { detectProvider } = await importStartupScreenWithModels()
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-6'
    process.env.CLAUDE_MODEL = 'sonnet'

    const result = detectProvider()

    expect(result.name).toBe('Verboo')
    expect(result.baseUrl).toBe(VERBOO_ROUTER_URL)
    expect(result.model).not.toMatch(/claude|sonnet|opus|haiku/i)
  })

  test('ignores stale provider env vars from Claude Code sessions', async () => {
    const { detectProvider } = await importStartupScreenWithModels()
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'
    process.env.OPENAI_MODEL = 'claude-sonnet-4-6'
    process.env.OPENAI_API_KEY = 'test-key'

    const result = detectProvider()

    expect(result.name).toBe('Verboo')
    expect(result.baseUrl).toBe(VERBOO_ROUTER_URL)
    expect(result.model).not.toMatch(/claude|sonnet|opus|haiku/i)
  })

  test('ignores Claude-like --model overrides', async () => {
    const { detectProvider } = await importStartupScreenWithModels()
    const result = detectProvider('claude-opus-4-6')

    expect(result.name).toBe('Verboo')
    expect(result.baseUrl).toBe(VERBOO_ROUTER_URL)
    expect(result.model).not.toMatch(/claude|sonnet|opus|haiku/i)
  })

  test('allows non-Claude Verboo model override for banner display', async () => {
    const { detectProvider } = await importStartupScreenWithModels()
    const result = detectProvider('early-adopters/qwen3.6-27b')

    expect(result.name).toBe('Verboo')
    expect(result.model).toBe('early-adopters/qwen3.6-27b')
  })

  test('uses persisted Verboo model when no CLI override is provided', async () => {
    const { detectProvider } = await importStartupScreenWithModels(
      [
        { id: 'early-adopters/qwen3.6-27b' },
        { id: 'early-adopters/qwen3.5-397b' },
      ],
      'early-adopters/qwen3.5-397b',
    )
    const result = detectProvider()

    expect(result.name).toBe('Verboo')
    expect(result.model).toBe('early-adopters/qwen3.5-397b')
  })

  test('falls back to router default when persisted Verboo model is unavailable', async () => {
    const { detectProvider } = await importStartupScreenWithModels(
      [
        { id: 'early-adopters/qwen3.6-27b' },
        { id: 'early-adopters/qwen3.5-397b' },
      ],
      'early-adopters/removed-model',
    )
    const result = detectProvider()

    expect(result.name).toBe('Verboo')
    expect(result.model).toBe('early-adopters/qwen3.6-27b')
  })

  test('throws purchase message when models were not loaded', async () => {
    const { detectProvider } = await importStartupScreenWithModels([])

    expect(() => detectProvider()).toThrow(
      'Compre acesso em https://code.verboo.ai',
    )
  })
})
