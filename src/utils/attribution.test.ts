import { afterEach, describe, expect, test } from 'bun:test'

import {
  applyAttributionSettings,
  getDefaultCommitAttribution,
  VERBOO_COMMIT_CO_AUTHOR,
} from './attribution.js'

const originalEnv = { ...process.env }

afterEach(() => {
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
