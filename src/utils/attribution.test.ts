import { afterEach, beforeEach, describe, expect, it, mock, test } from 'bun:test'

import {
  applyAttributionSettings,
  getDefaultCommitAttribution,
  getDefaultCommitCoAuthorEmail,
  getDefaultCommitCoAuthorName,
  VERBOO_COMMIT_CO_AUTHOR,
} from './attribution.js'

const originalEnv = { ...process.env }

beforeEach(() => {
  mock.module('../constants/oauth.js', () => ({
    isVerbooMode: () => true,
  }))
})

afterEach(() => {
  mock.restore()
  process.env = { ...originalEnv }
})

describe('commit attribution branding', () => {
  test('uses Verboo Code as the default commit co-author in Verboo mode', () => {
    expect(getDefaultCommitAttribution()).toBe(VERBOO_COMMIT_CO_AUTHOR)
    expect(VERBOO_COMMIT_CO_AUTHOR).toBe(
      'Co-Authored-By: Verboo Code <noreply@code.verboo.ai>',
    )
  })

  test('respects VERBOO_DISABLE_CO_AUTHORED_BY', () => {
    process.env.VERBOO_DISABLE_CO_AUTHORED_BY = '1'

    expect(getDefaultCommitAttribution()).toBe('')
  })

  test('preserves custom attribution settings', () => {
    const result = applyAttributionSettings(
      {
        attribution: {
          commit: 'Co-Authored-By: Custom Bot <bot@example.com>',
          pr: 'Custom PR attribution',
        },
      },
      {
        commit: VERBOO_COMMIT_CO_AUTHOR,
        pr: '🤖 Generated with Verboo Code',
      },
    )

    expect(result).toEqual({
      commit: 'Co-Authored-By: Custom Bot <bot@example.com>',
      pr: 'Custom PR attribution',
    })
  })

  test('preserves deprecated includeCoAuthoredBy=false behavior', () => {
    const result = applyAttributionSettings(
      { includeCoAuthoredBy: false },
      {
        commit: VERBOO_COMMIT_CO_AUTHOR,
        pr: '🤖 Generated with Verboo Code',
      },
    )

    expect(result).toEqual({ commit: '', pr: '' })
  })
})

describe('getDefaultCommitCoAuthorName', () => {
  it('does not label unknown non-Claude provider models as Opus', () => {
    expect(
      getDefaultCommitCoAuthorName({
        model: 'gpt-5.5',
        apiProvider: 'openai',
        isInternalRepo: false,
      }),
    ).toBe('Verboo Code (gpt-5.5)')
  })

  it('does not apply internal Claude formatting to non-Claude providers', () => {
    expect(
      getDefaultCommitCoAuthorName({
        model: 'gpt-5.5',
        apiProvider: 'openai',
        isInternalRepo: true,
      }),
    ).toBe('Verboo Code (gpt-5.5)')
  })

  it('keeps the codename-safe fallback for unknown first-party models', () => {
    expect(
      getDefaultCommitCoAuthorName({
        model: 'unreleased-internal-model',
        apiProvider: 'firstParty',
        isInternalRepo: false,
      }),
    ).toBe('Claude Opus 4.6')
  })

  it('sanitizes unknown internal Claude co-author names', () => {
    expect(
      getDefaultCommitCoAuthorName({
        model: 'bad\nmodel<id>',
        apiProvider: 'firstParty',
        isInternalRepo: true,
      }),
    ).toBe('Claude (bad model id)')
  })

  it('does not duplicate the Claude prefix for Claude model names', () => {
    expect(
      getDefaultCommitCoAuthorName({
        model: 'claude-opus-4-6',
        apiProvider: 'firstParty',
        isInternalRepo: false,
      }),
    ).toBe('Claude Opus 4.6')
  })

  it('uses the Verboo email for commit attribution across providers', () => {
    expect(getDefaultCommitCoAuthorEmail('openai')).toBe(
      'noreply@code.verboo.ai',
    )
    expect(getDefaultCommitCoAuthorEmail('firstParty')).toBe(
      'noreply@code.verboo.ai',
    )
  })
})
