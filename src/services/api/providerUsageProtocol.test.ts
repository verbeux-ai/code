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

test('Claude native limits schema (percent + scope.model.display_name) surfaces a Fable weekly window', () => {
  // Fixture capturada do payload real de /api/oauth/usage: o array `limits`
  // usa `percent` (não utilization), `scope.model.display_name` (não
  // model_scope) e não carrega `id` nem `window_seconds`.
  const snapshot = normalizeClaudeProviderUsage(
    'local-claude',
    { id: 'pro', displayName: 'Pro' },
    {
      five_hour: {
        utilization: 8,
        resets_at: '2026-08-10T16:00:00.500089+00:00',
      },
      seven_day: {
        utilization: 5,
        resets_at: '2026-08-16T21:00:00.500115+00:00',
      },
      limits: [
        {
          kind: 'session',
          group: 'session',
          percent: 8,
          severity: 'normal',
          resets_at: '2026-08-10T16:00:00.500089+00:00',
          scope: null,
          is_active: false,
        },
        {
          kind: 'weekly_all',
          group: 'weekly',
          percent: 5,
          severity: 'normal',
          resets_at: '2026-08-16T21:00:00.500115+00:00',
          scope: null,
          is_active: false,
        },
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          percent: 9,
          severity: 'normal',
          resets_at: '2026-08-16T21:00:00.500504+00:00',
          scope: { model: { id: null, display_name: 'Fable' }, surface: null },
          is_active: true,
        },
      ],
    },
  )

  expect(snapshot.windows.map(window => window.kind)).toEqual([
    'session',
    'weekly',
    'model-scoped-weekly',
  ])
  expect(snapshot.windows.at(-1)).toMatchObject({
    id: 'claude:weekly-fable',
    kind: 'model-scoped-weekly',
    displayLabel: 'Fable Weekly',
    modelScope: 'fable',
    usedPercent: 9,
    resetsAt: '2026-08-16T21:00:00.500504+00:00',
  })
})

test('scoped Fable window sanitizes internal model ids from the scope object', () => {
  const snapshot = normalizeClaudeProviderUsage(
    'local-claude',
    { id: 'pro', displayName: 'Pro' },
    {
      five_hour: null,
      seven_day: null,
      limits: [
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          percent: 12,
          severity: 'normal',
          resets_at: '2026-08-16T21:00:00.500504+00:00',
          scope: {
            model: { id: 'internal-model-mdrv-0123', display_name: 'Fable' },
            surface: 'chat',
          },
          is_active: true,
        },
      ],
    },
  )

  const json = JSON.stringify(snapshot)
  expect(json).not.toContain('internal-model-mdrv-0123')
  expect(json).not.toContain('surface')
  expect(snapshot.windows.at(-1)).toMatchObject({
    displayLabel: 'Fable Weekly',
    modelScope: 'fable',
    usedPercent: 12,
  })
})

test('Claude Pro payload without scoped limits fabricates no Fable row', () => {
  // Payload sem limits[]/scoped_limits: o protocolo NÃO pode inventar uma
  // janela model-scoped-weekly — exatamente [session, weekly].
  const snapshot = normalizeClaudeProviderUsage(
    'local-pro',
    { id: 'pro', displayName: 'Pro' },
    {
      five_hour: { utilization: 8 },
      seven_day: { utilization: 20 },
    },
  )

  expect(snapshot.windows).toEqual([
    {
      id: 'claude:five-hour',
      kind: 'session',
      displayLabel: '5 hours',
      usedPercent: 8,
    },
    {
      id: 'claude:weekly',
      kind: 'weekly',
      displayLabel: 'Weekly',
      usedPercent: 20,
    },
  ])
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
