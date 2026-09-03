import { describe, expect, test } from 'bun:test'

import { AGENT_MODEL_PROFILES } from './agentModelProfiles.js'

const productionModels = [
  'deepseek-v4-flash',
  'deepseek-v4-flash-0731',
  'deepseek-v4-pro',
  'deepseek-v4-pro-0813',
  'glm-5.2',
  'glm-5.3-flash',
  'kimi-k2.7',
  'mimo-v2.5',
  'mimo-v2.5-pro',
  'minimax-m3',
  'qwen3.6-27b',
  'qwen3.8-27b',
] as const

describe('AGENT_MODEL_PROFILES', () => {
  test('keeps every compatibility profile aligned with the production catalog', () => {
    const expected = [...productionModels].sort()

    for (const candidates of Object.values(AGENT_MODEL_PROFILES)) {
      expect([...new Set(candidates)].sort()).toEqual(expected)
    }
  })

  test('preserves the established first choice for each workload', () => {
    expect(
      Object.fromEntries(
        Object.entries(AGENT_MODEL_PROFILES).map(([profile, models]) => [
          profile,
          models[0],
        ]),
      ),
    ).toEqual({
      fast: 'deepseek-v4-flash',
      review: 'deepseek-v4-pro',
      coding: 'mimo-v2.5-pro',
      testing: 'qwen3.6-27b',
      balanced: 'mimo-v2.5',
    })
  })
})
