import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { VERBOO_ROUTER_URL } from '../constants/oauth.js'
import { detectProvider } from './StartupScreen.js'

const ENV_KEYS = [
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
]

const originalEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = originalEnv[key]
    }
  }
})

describe('detectProvider — Verboo isolation', () => {
  test('uses Verboo router by default', () => {
    const result = detectProvider()

    expect(result.name).toBe('Verboo')
    expect(result.baseUrl).toBe(VERBOO_ROUTER_URL)
    expect(result.model).not.toContain('claude')
  })

  test('ignores stale Claude model env vars', () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-6'
    process.env.CLAUDE_MODEL = 'sonnet'

    const result = detectProvider()

    expect(result.name).toBe('Verboo')
    expect(result.baseUrl).toBe(VERBOO_ROUTER_URL)
    expect(result.model).not.toMatch(/claude|sonnet|opus|haiku/i)
  })

  test('ignores stale provider env vars from Claude Code sessions', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'
    process.env.OPENAI_MODEL = 'claude-sonnet-4-6'
    process.env.OPENAI_API_KEY = 'test-key'

    const result = detectProvider()

    expect(result.name).toBe('Verboo')
    expect(result.baseUrl).toBe(VERBOO_ROUTER_URL)
    expect(result.model).not.toMatch(/claude|sonnet|opus|haiku/i)
  })

  test('ignores Claude-like --model overrides', () => {
    const result = detectProvider('claude-opus-4-6')

    expect(result.name).toBe('Verboo')
    expect(result.baseUrl).toBe(VERBOO_ROUTER_URL)
    expect(result.model).not.toMatch(/claude|sonnet|opus|haiku/i)
  })

  test('allows non-Claude Verboo model override for banner display', () => {
    const result = detectProvider('early-adopters/qwen3.6-27b')

    expect(result.name).toBe('Verboo')
    expect(result.model).toBe('early-adopters/qwen3.6-27b')
  })
})
