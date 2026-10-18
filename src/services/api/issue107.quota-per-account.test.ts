/**
 * Regression test for issue #107 (CLI half) — explicit account selection
 * must win over env credentials, and the usage envelope must include the
 * duration of every window the provider reports.
 *
 * Repro pattern from the field RCA:
 *   - 2 Codex accounts stored in secure storage with distinct tokens and
 *     provider-account-ids.
 *   - CODEX_HOME points at a third credential file.
 *   - `provider-accounts usage --provider codex --account <id>` today
 *     returns the env credential and only the 10080-min window, so the
 *     app receives one identical snapshot for both accounts.
 *
 * Spec from frontend-issue107-2026-08-28.md (validated by review-issue107):
 *   1. Explicit account selection uses the secure-storage token; envs do
 *      not substitute.
 *   2. Envelope returns ALL provider-reported windows (primary + secondary),
 *      including arbitrary durations.
 *   3. Each window carries `windowMinutes?: positive integer` (additive).
 */
import { afterEach, expect, mock, test } from 'bun:test'

import { resolveRuntimeCodexCredentials } from './providerConfig.js'
import {
  normalizeCodexProviderUsage,
  normalizeClaudeProviderUsage,
} from './providerUsageProtocol.js'

afterEach(() => {
  mock.restore()
})

// ─── Bug 1 — env credentials must NOT substitute explicit account selection ─

test('env CODEX_HOME does NOT override a stored credential passed for explicit account selection', () => {
  const credentials = resolveRuntimeCodexCredentials({
    env: {
      CODEX_HOME: '/env/path/that/should/not/win',
      CODEX_ACCOUNT_ID: 'acct_env_account',
    } as NodeJS.ProcessEnv,
    storedCredentials: {
      apiKey: 'stored-selected-api-key',
      accessToken: 'stored-selected-access-token',
      accountId: 'acct_selected',
    },
  })

  expect(credentials.source).toBe('secure-storage')
  expect(credentials.accountId).toBe('acct_selected')
  expect(credentials.apiKey).toBe('stored-selected-api-key')
})

test('env CODEX_AUTH_JSON_PATH does NOT override a stored credential passed for explicit account selection', () => {
  const credentials = resolveRuntimeCodexCredentials({
    env: {
      CODEX_AUTH_JSON_PATH: '/env/auth.json/that/should/not/win',
      CODEX_ACCOUNT_ID: 'acct_env_account',
    } as NodeJS.ProcessEnv,
    storedCredentials: {
      apiKey: 'stored-selected-api-key',
      accessToken: 'stored-selected-access-token',
      accountId: 'acct_selected',
    },
  })

  expect(credentials.source).toBe('secure-storage')
  expect(credentials.accountId).toBe('acct_selected')
})

test('localAccountId parameter pulls from secure storage even when env credentials are present', async () => {
  mock.module('../../utils/codexCredentials.js', () => ({
    isCodexRefreshFailureCoolingDown: () => false,
    readCodexCredentials: (_localAccountId?: string) => ({
      accessToken: 'selected-token-from-secure-storage',
      accountId: 'acct_from_secure_storage',
    }),
  }))

  // Cache-busting query string so Bun re-imports providerConfig after the
  // mock.module above changes which credentials function resolves.
  const { resolveRuntimeCodexCredentials } = await import(
    // @ts-expect-error cache-busting query string for Bun module mocks
    './providerConfig.js?red-107-local-account-vs-env'
  )

  const credentials = resolveRuntimeCodexCredentials({
    env: {
      CODEX_HOME: '/env/path/that/should/not/win',
      CODEX_ACCOUNT_ID: 'acct_env_account',
    } as NodeJS.ProcessEnv,
    localAccountId: 'local-selected',
  })
  expect(credentials.source).toBe('secure-storage')
  expect(credentials.accountId).toBe('acct_from_secure_storage')
  expect(credentials.apiKey).toBe('selected-token-from-secure-storage')
})

// ─── Bug 2 — usage envelope must include every provider-reported window ──

test('Codex envelope surfaces BOTH primary and secondary windows with their reported durations', () => {
  const snapshot = normalizeCodexProviderUsage('local-plus', {
    plan_type: 'plus',
    rate_limit: {
      primary_window: {
        used_percent: 11,
        limit_window_seconds: 180 * 60,
        reset_at: 1_775_685_041,
      },
      secondary_window: {
        used_percent: 73,
        limit_window_seconds: 480 * 60,
        reset_at: 1_775_771_441,
      },
    },
  })

  const primary = snapshot.windows.find(w => w.id === 'codex:codex:primary')
  const secondary = snapshot.windows.find(w => w.id === 'codex:codex:secondary')
  expect(primary).toBeDefined()
  expect(primary?.usedPercent).toBe(11)
  expect(primary?.windowMinutes).toBe(180)
  expect(secondary).toBeDefined()
  expect(secondary?.usedPercent).toBe(73)
  expect(secondary?.windowMinutes).toBe(480)
})

test('Codex envelope surfaces arbitrary durations (not only 10080)', () => {
  const snapshot = normalizeCodexProviderUsage('local-plus', {
    plan_type: 'plus',
    rate_limit: {
      primary_window: {
        used_percent: 30,
        limit_window_seconds: 300 * 60,
      },
      secondary_window: {
        used_percent: 42,
        limit_window_seconds: 4320 * 60,
      },
    },
  })

  const weekly = snapshot.windows.find(w => w.kind === 'weekly')
  expect(weekly).toBeDefined()
  expect(weekly?.usedPercent).toBe(42)
  expect(weekly?.windowMinutes).toBe(4320)
})

test('Claude envelope surfaces scoped windows with arbitrary durations', () => {
  const snapshot = normalizeClaudeProviderUsage(
    'local-claude',
    { id: 'pro', displayName: 'Pro' },
    {
      five_hour: { utilization: 8, resets_at: '2026-08-10T16:00:00.000Z' },
      seven_day: { utilization: 5, resets_at: '2026-08-16T21:00:00.000Z' },
      scoped_limits: [
        {
          id: 'fable',
          utilization: 9,
          resets_at: '2026-08-16T21:00:00.000Z',
          windowMinutes: 1440,
          modelScope: 'fable',
        },
        {
          id: 'sora',
          utilization: 12,
          resets_at: '2026-08-12T12:00:00.000Z',
          windowMinutes: 4320,
          modelScope: 'sora',
        },
      ],
    },
  )

  const weeklyScopeds = snapshot.windows.filter(
    w => w.kind === 'model-scoped-weekly',
  )
  const fableWindow = weeklyScopeds.find(w => w.modelScope === 'fable')
  const soraWindow = weeklyScopeds.find(w => w.modelScope === 'sora')
  expect(fableWindow).toBeDefined()
  expect(fableWindow?.usedPercent).toBe(9)
  expect(fableWindow?.windowMinutes).toBe(1440)
  expect(soraWindow).toBeDefined()
  expect(soraWindow?.usedPercent).toBe(12)
  expect(soraWindow?.windowMinutes).toBe(4320)
})