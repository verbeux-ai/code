import { describe, expect, test } from 'bun:test'
import { classifyActiveModelProvider } from './activeModelIdentity.js'

describe('classifyActiveModelProvider', () => {
  test('mirrors runtime routing priority across the three catalogs', () => {
    const catalogs = {
      verboo: [{ id: 'shared-model' }, { id: 'verboo-ultra' }],
      codex: [{ id: 'shared-model' }, { id: 'gpt-5.5' }],
      claude: [{ id: 'shared-model' }, { id: 'claude-opus-4-6' }],
    }

    expect(classifyActiveModelProvider('shared-model', catalogs)).toBe('Verboo')
    expect(classifyActiveModelProvider('gpt-5.5', catalogs)).toBe('Codex')
    expect(classifyActiveModelProvider('claude-opus-4-6', catalogs)).toBe('Claude')
  })

  test('recognizes provider-shaped IDs when catalogs are unavailable', () => {
    const emptyCatalogs = { verboo: null, codex: null, claude: null }

    expect(classifyActiveModelProvider('gpt-5.3-codex', emptyCatalogs)).toBe('Codex')
    expect(classifyActiveModelProvider('claude-sonnet-4-6[1m]', emptyCatalogs)).toBe('Claude')
    expect(classifyActiveModelProvider('ultra/minimax-m3', emptyCatalogs)).toBe('Verboo')
  })

  test('models reached with the user\'s OpenAI key are labeled OpenAI, not Codex', () => {
    const catalogs = {
      verboo: [{ id: 'verboo-ultra' }],
      codex: [{ id: 'gpt-5.5' }],
      claude: null,
      openai: [{ id: 'openai-api/gpt-5.5' }],
    }

    expect(classifyActiveModelProvider('gpt-5.5', catalogs)).toBe('Codex')
    expect(classifyActiveModelProvider('openai-api/gpt-5.5', catalogs)).toBe('OpenAI')
    expect(
      classifyActiveModelProvider('openai-api/o4-mini', { verboo: null, codex: null, claude: null }),
    ).toBe('OpenAI')
  })
})
