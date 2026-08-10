import { afterEach, expect, mock, test } from 'bun:test'

import type { ProviderAccountsV1 } from '../../utils/providerAccounts/types.js'

afterEach(() => {
  mock.restore()
})

function accountState(): ProviderAccountsV1 {
  return {
    schemaVersion: 1,
    codex: {
      defaultAccountId: 'local-a',
      accounts: {
        'local-a': {
          localAccountId: 'local-a',
          providerSubjectId: 'provider-secret',
          displayLabel: 'Codex 1',
          credential: { accessToken: 'token-secret', accountId: 'provider-secret' },
          connectionState: 'connected',
        },
      },
    },
    claude: { accounts: {} },
  }
}

test('list returns only sanitized account fields', async () => {
  const state = accountState()
  mock.module('../../utils/providerAccounts/store.js', () => ({
    listProviderAccountSummaries: () => [{
      provider: 'codex',
      accountId: 'local-a',
      displayLabel: 'Codex 1',
      isDefault: true,
      connectionState: 'connected',
    }],
    readProviderAccounts: () => state,
    resolveProviderAccount: () => state.codex.accounts['local-a'],
    resolveProviderAccountByLocalId: () => undefined,
    normalizeProviderAccounts: () => undefined,
    removeProviderAccount: () => {},
    setDefaultProviderAccount: () => {},
    upsertProviderAccount: () => ({ localAccountId: 'local-a', created: false }),
  }))

  // @ts-expect-error cache-busting query string for Bun module mocks
  const { runProviderAccountsCommand } = await import('./providerAccounts.js?list')
  const output = await runProviderAccountsCommand(['list'], {
    ensureAuthenticated: async () => {},
  })

  expect(output).toEqual({
    schemaVersion: 1,
    ok: true,
    data: {
      protocols: ['provider_accounts_v1', 'provider_usage_v1'],
      accounts: [{
        schemaVersion: 1,
        provider: 'codex',
        accountId: 'local-a',
        displayLabel: 'Codex 1',
        planId: undefined,
        planDisplayName: undefined,
        isDefault: true,
        connectionState: 'connected',
        lastValidatedAt: undefined,
      }],
    },
  })
  expect(JSON.stringify(output)).not.toContain('token-secret')
  expect(JSON.stringify(output)).not.toContain('provider-secret')
})

test('capabilities advertises the versioned protocols and PTY login transport', async () => {
  mock.module('../../utils/providerAccounts/store.js', () => ({
    readProviderAccounts: () => ({ schemaVersion: 1, codex: { accounts: {} }, claude: { accounts: {} } }),
    listProviderAccountSummaries: () => [],
    resolveProviderAccount: () => undefined,
    normalizeProviderAccounts: () => undefined,
    resolveProviderAccountByLocalId: () => undefined,
    removeProviderAccount: () => {},
    setDefaultProviderAccount: () => {},
    upsertProviderAccount: () => ({ localAccountId: 'local-a', created: false }),
  }))

  // @ts-expect-error cache-busting query string for Bun module mocks
  const { runProviderAccountsCommand } = await import('./providerAccounts.js?capabilities')
  await expect(
    runProviderAccountsCommand(['capabilities'], {
      ensureAuthenticated: async () => {},
    }),
  ).resolves.toEqual({
    schemaVersion: 1,
    ok: true,
    data: {
      protocols: ['provider_accounts_v1', 'provider_usage_v1'],
      loginTransport: 'pty-slash-v1',
      secureStorage: { native: true, backend: expect.any(String), probe: expect.stringMatching(/^(ok|missing|error)$/) },
    },
  })
})

test('unknown account fails closed with a stable code', async () => {
  mock.module('../../utils/providerAccounts/store.js', () => ({
    readProviderAccounts: () => accountState(),
    resolveProviderAccount: () => undefined,
    resolveProviderAccountByLocalId: () => undefined,
    listProviderAccountSummaries: () => [],
    normalizeProviderAccounts: () => undefined,
    removeProviderAccount: () => {},
    setDefaultProviderAccount: () => {},
    upsertProviderAccount: () => ({ localAccountId: 'local-a', created: false }),
  }))

  // @ts-expect-error cache-busting query string for Bun module mocks
  const { runProviderAccountsCommand } = await import('./providerAccounts.js?missing')
  await expect(
    runProviderAccountsCommand(
      ['usage', '--provider', 'codex', '--account', 'missing'],
      { ensureAuthenticated: async () => {} },
    ),
  ).resolves.toMatchObject({
    ok: false,
    error: { code: 'provider_account_not_found' },
  })
})

test('authentication is checked before the vault is read', async () => {
  let readCalled = false
  mock.module('../../utils/providerAccounts/store.js', () => ({
    readProviderAccounts: () => {
      readCalled = true
      throw new Error('vault must not be read')
    },
    listProviderAccountSummaries: () => {
      readCalled = true
      throw new Error('vault must not be read')
    },
    resolveProviderAccount: () => {
      readCalled = true
      throw new Error('vault must not be read')
    },
    resolveProviderAccountByLocalId: () => undefined,
    normalizeProviderAccounts: () => undefined,
    removeProviderAccount: () => {},
    setDefaultProviderAccount: () => {},
    upsertProviderAccount: () => ({ localAccountId: 'local-a', created: false }),
  }))

  // @ts-expect-error cache-busting query string for Bun module mocks
  const { runProviderAccountsCommand } = await import('./providerAccounts.js?auth')
  const output = await runProviderAccountsCommand(['list'], {
    ensureAuthenticated: async () => {
      throw new Error('not authenticated')
    },
  })

  expect(output).toMatchObject({
    ok: false,
    error: { code: 'verboo_auth_required' },
  })
  expect(readCalled).toBe(false)
})

test('usage resolves the requested opaque account and returns protocol v1 data', async () => {
  const state = accountState()
  let usageAccountId = ''
  mock.module('../../utils/providerAccounts/store.js', () => ({
    readProviderAccounts: () => state,
    resolveProviderAccount: (provider: string, accountId: string) =>
      provider === 'codex' && accountId === 'local-a'
        ? state.codex.accounts['local-a']
        : undefined,
    listProviderAccountSummaries: () => [],
    normalizeProviderAccounts: () => undefined,
    resolveProviderAccountByLocalId: () => undefined,
    removeProviderAccount: () => {},
    setDefaultProviderAccount: () => {},
    upsertProviderAccount: () => ({ localAccountId: 'local-a', created: false }),
  }))
  const fetchProviderUsage = async (provider: string, accountId: string) => {
      usageAccountId = `${provider}:${accountId}`
      return {
        schemaVersion: 1,
        provider,
        accountId,
        windows: [],
        fetchedAt: '2026-08-09T00:00:00.000Z',
      }
  }

  // @ts-expect-error cache-busting query string for Bun module mocks
  const { runProviderAccountsCommand } = await import('./providerAccounts.js?usage')
  const output = await runProviderAccountsCommand(
    ['usage', '--provider', 'codex', '--account', 'local-a'],
    { ensureAuthenticated: async () => {}, fetchProviderUsage },
  )

  expect(usageAccountId).toBe('codex:local-a')
  expect(output).toMatchObject({
    ok: true,
    data: { provider: 'codex', accountId: 'local-a', schemaVersion: 1 },
  })
})

test('models resolves the requested account without exposing provider credentials', async () => {
  const state = accountState()
  let modelsAccountId = ''
  mock.module('../../utils/providerAccounts/store.js', () => ({
    readProviderAccounts: () => state,
    resolveProviderAccount: (provider: string, accountId: string) =>
      provider === 'codex' && accountId === 'local-a' ? state.codex.accounts['local-a'] : undefined,
    listProviderAccountSummaries: () => [],
    resolveProviderAccountByLocalId: () => undefined,
    normalizeProviderAccounts: () => undefined,
    removeProviderAccount: () => {},
    setDefaultProviderAccount: () => {},
    upsertProviderAccount: () => ({ localAccountId: 'local-a', created: false }),
  }))
  mock.module('../../services/api/codexModels.js', () => ({
    fetchCodexModels: async (options?: { localAccountId?: string }) => {
      modelsAccountId = options?.localAccountId ?? ''
      return [{ id: 'gpt-5.6', displayName: 'GPT-5.6', contextWindow: 272_000 }]
    },
  }))

  // @ts-expect-error cache-busting query string for Bun module mocks
  const { runProviderAccountsCommand } = await import('./providerAccounts.js?models')
  const output = await runProviderAccountsCommand(
    ['models', '--provider', 'codex', '--account', 'local-a'],
    { ensureAuthenticated: async () => {} },
  )

  expect(modelsAccountId).toBe('local-a')
  expect(output).toEqual({
    schemaVersion: 1,
    ok: true,
    data: [{ id: 'gpt-5.6', displayName: 'GPT-5.6', contextWindow: 272_000, provider: 'codex', raw: {} }],
  })
  expect(JSON.stringify(output)).not.toContain('token-secret')
})
