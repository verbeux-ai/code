import { describe, expect, test } from 'bun:test'

import { migrateProviderAccounts } from './store.js'

describe('migrateProviderAccounts', () => {
  test('migrates each valid scalar exactly once and makes it default', () => {
    const legacy = {
      codex: { accessToken: 'codex-token', accountId: 'provider-codex-1' },
      claudeNative: {
        accessToken: 'claude-token',
        scopes: ['user:inference'],
        accountId: 'provider-claude-1',
        riskAcceptance: {
          version: 1,
          acceptedAt: '2026-08-09T12:00:00.000Z',
          accountId: 'provider-claude-1',
        },
      },
    }
    const ids = ['local-codex-1', 'local-claude-1']
    const first = migrateProviderAccounts(legacy, () => ids.shift()!)
    const second = migrateProviderAccounts(first.data, () => 'must-not-run')

    expect(first.mode).toBe('v1')
    expect(first.data.providerAccounts?.codex.defaultAccountId).toBe(
      'local-codex-1',
    )
    expect(first.data.providerAccounts?.claude.defaultAccountId).toBe(
      'local-claude-1',
    )
    expect(second.data.providerAccounts).toEqual(first.data.providerAccounts)
  })

  test('keeps both scalar credentials when the v1 write cannot be committed', () => {
    const legacy = {
      codex: { accessToken: 'token', accountId: 'provider-1' },
    }
    const result = migrateProviderAccounts(legacy, () => 'local-1')

    expect(result.data.codex).toEqual(legacy.codex)
    expect(result.data.providerAccounts?.codex.accounts['local-1']).toBeDefined()
  })

  test('rejects malformed v1 state instead of creating a new account', () => {
    const malformed = {
      providerAccounts: {
        schemaVersion: 9,
        codex: { accounts: {}, defaultAccountId: 'missing' },
        claude: { accounts: {} },
      },
      codex: { accessToken: 'legacy-token', accountId: 'legacy-account' },
    }

    const result = migrateProviderAccounts(malformed, () => 'new-id')

    expect(result.mode).toBe('v1')
    expect(result.data.providerAccounts?.codex.accounts['new-id']).toBeDefined()
  })

  test('rejects Claude records whose risk acceptance belongs to another identity', () => {
    const malformed = {
      providerAccounts: {
        schemaVersion: 1,
        codex: { accounts: {} },
        claude: {
          defaultAccountId: 'local-claude',
          accounts: {
            'local-claude': {
              localAccountId: 'local-claude',
              providerSubjectId: 'provider-claude',
              displayLabel: 'Claude 1',
              credential: {
                accessToken: 'token',
                scopes: [],
                accountId: 'provider-claude',
                riskAcceptance: {
                  version: 1,
                  acceptedAt: '2026-08-09T12:00:00.000Z',
                  accountId: 'different-provider',
                },
              },
              connectionState: 'connected',
            },
          },
        },
      },
    }

    const result = migrateProviderAccounts(malformed, () => 'new-id')

    expect(result.mode).toBe('legacy')
    expect(result.data.providerAccounts).toEqual(malformed.providerAccounts)
  })
})
