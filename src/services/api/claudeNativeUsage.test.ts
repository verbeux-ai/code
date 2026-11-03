import { describe, expect, test } from 'bun:test'

import {
  buildClaudeNativeUsageRows,
  CLAUDE_API_KEY_USAGE_UNAVAILABLE,
  fetchClaudeNativeUsage,
  normalizeClaudeNativeUsagePayload,
} from './claudeNativeUsage.js'

describe('Claude native usage helpers', () => {
  test('normalizes all subscription windows returned by the OAuth usage API', () => {
    const usage = normalizeClaudeNativeUsagePayload({
      five_hour: {
        utilization: 31.7,
        resets_at: '2026-08-06T20:00:00.000Z',
      },
      seven_day: {
        utilization: 42,
        resets_at: '2026-08-10T20:00:00.000Z',
      },
      seven_day_opus: {
        used_percentage: 9,
        resetsAt: '2026-08-10T20:00:00.000Z',
      },
      seven_day_sonnet: null,
      extra_usage: {
        is_enabled: true,
        monthly_limit: 5000,
        used_credits: 1200,
        utilization: 24,
      },
    })

    expect(usage).toMatchObject({
      five_hour: { utilization: 31.7 },
      seven_day: { utilization: 42 },
      seven_day_opus: { utilization: 9 },
      seven_day_sonnet: null,
      extra_usage: {
        is_enabled: true,
        monthly_limit: 5000,
        used_credits: 1200,
        utilization: 24,
      },
    })
  })

  test('builds only rows backed by usage data', () => {
    const rows = buildClaudeNativeUsageRows(
      normalizeClaudeNativeUsagePayload({
        five_hour: { utilization: 15, resets_at: null },
        seven_day: { utilization: 20, resets_at: null },
        seven_day_opus: null,
      }),
    )

    expect(rows.map(row => row.label)).toEqual([
      'Current session',
      'Current week (all models)',
    ])
  })

  test('API keys have no usage windows, so nothing is fetched', async () => {
    const previousFetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = (async () => {
      requests += 1
      return new Response('{}')
    }) as unknown as typeof fetch
    try {
      await expect(fetchClaudeNativeUsage()).rejects.toThrow(
        CLAUDE_API_KEY_USAGE_UNAVAILABLE,
      )
      expect(requests).toBe(0)
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test('retains only explicitly reported model-scoped weekly limits', () => {
    const usage = normalizeClaudeNativeUsagePayload({
      limits: [
        {
          id: 'fable',
          model_scope: 'fable',
          window_seconds: 604_800,
          utilization: 25,
          resets_at: '2026-08-16T20:00:00.000Z',
        },
        { id: 'malformed', model_scope: 'spark', utilization: 'unknown' },
      ],
    })

    expect(usage.scoped_limits).toEqual([
      {
        id: 'fable',
        modelScope: 'fable',
        utilization: 25,
        windowMinutes: 10_080,
        resetsAt: '2026-08-16T20:00:00.000Z',
      },
    ])
  })
})
