import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import stripAnsi from 'strip-ansi'
import { VERBOO_ROUTER_URL } from '../constants/oauth.js'
import { detectProvider, renderStartupScreen } from './StartupScreen.js'
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
  optionalModels: {
    codex?: Array<{ id: string }>
    claude?: Array<{ id: string }>
  } = {},
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
    getVerbooAgentModelForRole: () => undefined,
    getVerbooModelMeta: (modelId: string) =>
      models.find(model => model.id === modelId),
  }))
  mock.module('../services/api/codexModels.js', () => ({
    getCachedCodexModels: () => optionalModels.codex ?? [],
  }))
  mock.module('../services/api/claudeNativeModels.js', () => ({
    getCachedClaudeNativeModels: () => optionalModels.claude ?? [],
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

  test('labels an active Codex model from the Codex catalog', async () => {
    const { detectProvider } = await importStartupScreenWithModels(
      [{ id: 'early-adopters/qwen3.6-27b' }],
      undefined,
      { codex: [{ id: 'gpt-5.5' }] },
    )

    expect(detectProvider('gpt-5.5')).toMatchObject({
      name: 'Codex',
      model: 'gpt-5.5',
    })
  })

  test('labels an active Claude model from the Claude catalog', async () => {
    const { detectProvider } = await importStartupScreenWithModels(
      [{ id: 'early-adopters/qwen3.6-27b' }],
      undefined,
      { claude: [{ id: 'claude-opus-4-6' }] },
    )

    expect(detectProvider('claude-opus-4-6')).toMatchObject({
      name: 'Claude',
      model: 'claude-opus-4-6',
    })
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

  test('keeps the Verboo fallback when the catalog was not loaded', async () => {
    const { detectProvider } = await importStartupScreenWithModels([])

    expect(detectProvider().model).toBe('verboo-default')
  })
})

describe('renderStartupScreen', () => {
  const provider = {
    name: 'Verboo',
    model: 'early-adopters/qwen3.6-27b',
    baseUrl: 'https://code.verboo.ai/router/v1',
    isLocal: false,
  }

  test('uses the compact ghost identity in a wide terminal', () => {
    const output = renderStartupScreen(provider, '0.14.5', '~/project', 120)
    const plainOutput = stripAnsi(output)

    expect(plainOutput).toContain('👻')
    expect(plainOutput).toContain('Verboo Code')
    expect(plainOutput).toContain('Verboo · early-adopters/qwen3.6-27b')
    expect(plainOutput).not.toContain('▄▀▀▀▀▀▀▀▄')
    expect(plainOutput).not.toContain('Tokens ilimitados')
    expect(output).toContain('\x1b[0m')
    expect(output).not.toContain('undefined')
    expect(plainOutput.split('\n').every(line => line.length <= 120)).toBe(true)
  })

  test('keeps the compact identity in a narrow terminal', () => {
    const output = stripAnsi(
      renderStartupScreen(
        {
          ...provider,
          model: 'a-provider-model-name-that-is-long-enough-to-wrap',
        },
        '0.14.5',
        '~/a/very/long/project/path/that/would/wrap',
        70,
      ),
    )

    expect(output).toContain('👻')
    expect(output).not.toContain('▄▀▀▀▀▀▀▀▄')
    expect(output.split('\n').every(line => line.length <= 70)).toBe(true)
  })
})
