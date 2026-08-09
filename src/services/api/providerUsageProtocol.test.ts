import { afterEach, expect, mock, test } from 'bun:test'

import {
  normalizeClaudeProviderUsage,
  normalizeCodexProviderUsage,
} from './providerUsageProtocol.js'

afterEach(() => {
  mock.restore()
})

test('Codex Plus keeps only its provider-reported base weekly window', () => {
  const snapshot = normalizeCodexProviderUsage('local-plus', {
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 38, limit_window_seconds: 18_000 },
      secondary_window: {
        used_percent: 32,
        limit_window_seconds: 604_800,
        reset_at: 1_775_685_041,
      },
    },
  })

  expect(snapshot.plan).toEqual({ id: 'plus', displayName: 'Plus' })
  expect(snapshot.windows).toEqual([
    {
      id: 'codex:secondary',
      kind: 'weekly',
      displayLabel: 'Weekly',
      usedPercent: 32,
      resetsAt: '2026-04-08T21:50:41.000Z',
    },
  ])
})

test('Claude Pro has no Fable row while Max retains a reported scoped row', () => {
  const pro = normalizeClaudeProviderUsage(
    'local-pro',
    { id: 'pro', displayName: 'Pro' },
    {
      five_hour: { utilization: 15 },
      seven_day: { utilization: 20 },
    },
  )
  const max = normalizeClaudeProviderUsage(
    'local-max',
    { id: 'max', displayName: 'Max' },
    {
      five_hour: { utilization: 10 },
      seven_day: { utilization: 30 },
      limits: [
        {
          id: 'fable',
          model_scope: 'fable',
          window_seconds: 604_800,
          utilization: 25,
        },
      ],
    },
  )

  expect(pro.windows.map(window => window.kind)).toEqual(['session', 'weekly'])
  expect(max.windows.at(-1)).toMatchObject({
    kind: 'model-scoped-weekly',
    modelScope: 'fable',
    usedPercent: 25,
  })
})

test('normalization drops malformed or missing-reset windows without inventing values', () => {
  const snapshot = normalizeClaudeProviderUsage(
    'local-unknown',
    undefined,
    {
      five_hour: { utilization: 'not-a-number' },
      seven_day: { utilization: 50 },
      limits: [{ id: 'fable', utilization: 80 }],
    },
  )

  expect(snapshot.windows).toEqual([
    {
      id: 'claude:weekly',
      kind: 'weekly',
      displayLabel: 'Weekly',
      usedPercent: 50,
    },
  ])
})

test('fetchProviderUsage refreshes only the requested account and returns a sanitized snapshot', async () => {
  const requested: Array<{ provider: string; accountId: string }> = []
  mock.module('../../utils/providerAccounts/store.js', () => ({
    resolveProviderAccount: (provider: string, accountId: string) => {
      requested.push({ provider, accountId })
      return {
        localAccountId: accountId,
        providerSubjectId: 'provider-secret',
        displayLabel: 'Codex 2',
        credential: { accessToken: 'token-secret', accountId: 'provider-secret' },
        connectionState: 'connected',
      }
    },
  }))
  mock.module('./codexUsage.js', () => ({
    fetchCodexUsage: async (options?: { localAccountId?: string }) => {
      expect(options?.localAccountId).toBe('local-b')
      return {
        planType: 'plus',
        snapshots: [{
          limitName: 'codex',
          secondary: { usedPercent: 42, windowMinutes: 10_080 },
        }],
      }
    },
    normalizeCodexUsagePayload: () => ({ snapshots: [] }),
  }))

  // @ts-expect-error cache-busting query string for Bun module mocks
  const { fetchProviderUsage } = await import('./providerUsageProtocol.js?fetch-selected-account')
  const snapshot = await fetchProviderUsage('codex', 'local-b')

  expect(requested).toEqual([{ provider: 'codex', accountId: 'local-b' }])
  expect(snapshot).toMatchObject({
    provider: 'codex',
    accountId: 'local-b',
    windows: [{ usedPercent: 42 }],
  })
  expect(JSON.stringify(snapshot)).not.toContain('token-secret')
  expect(JSON.stringify(snapshot)).not.toContain('provider-secret')
})

test('fetchProviderUsage converts timeout failures to a stable code', async () => {
  mock.module('../../utils/providerAccounts/store.js', () => ({
    resolveProviderAccount: () => ({
      localAccountId: 'local-a',
      providerSubjectId: 'provider-a',
      displayLabel: 'Codex 1',
      credential: { accessToken: 'token', accountId: 'provider-a' },
      connectionState: 'connected',
    }),
  }))
  mock.module('./codexUsage.js', () => ({
    fetchCodexUsage: async () => {
      throw new Error('request timed out')
    },
    normalizeCodexUsagePayload: () => ({ snapshots: [] }),
  }))

  // @ts-expect-error cache-busting query string for Bun module mocks
  const { fetchProviderUsage } = await import('./providerUsageProtocol.js?fetch-timeout')
  await expect(fetchProviderUsage('codex', 'local-a')).rejects.toMatchObject({
    code: 'provider_usage_timeout',
  })
})
