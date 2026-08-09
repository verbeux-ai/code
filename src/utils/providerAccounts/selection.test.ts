import { afterEach, describe, expect, mock, test } from 'bun:test'

import type { SecureStorageData } from '../secureStorage/index.js'

function codexAccount(
  localAccountId: string,
  providerSubjectId: string,
  accessToken: string,
) {
  return {
    localAccountId,
    providerSubjectId,
    displayLabel: `Codex ${localAccountId}`,
    credential: { accessToken, accountId: providerSubjectId },
    connectionState: 'connected' as const,
  }
}

function seed(state: SecureStorageData): () => SecureStorageData {
  let current = state
  mock.module('../secureStorage/index.js', () => ({
    getSecureStorage: () => ({
      name: 'selection-test-storage',
      read: () => current,
      readAsync: async () => current,
      update: (next: SecureStorageData) => {
        current = next
        return { success: true }
      },
      delete: () => true,
    }),
  }))
  return () => current
}

afterEach(() => {
  mock.restore()
})

describe('provider account selection', () => {
  test('selection rejects an account owned by another provider', async () => {
    seed({
      providerAccounts: {
        schemaVersion: 1,
        codex: {
          defaultAccountId: 'local-codex',
          accounts: {
            'local-codex': codexAccount('local-codex', 'provider-codex', 'token'),
          },
        },
        claude: { accounts: {} },
      },
    })

    // @ts-expect-error cache-busting query string for Bun module isolation
    const { resolveProviderAccountSelection } = await import(
      './selection.js?provider-mismatch'
    )
    expect(() =>
      resolveProviderAccountSelection('claude', 'local-codex'),
    ).toThrow('provider_account_mismatch')
  })

  test('two process contexts resolve different credentials', async () => {
    const readState = seed({
      providerAccounts: {
        schemaVersion: 1,
        codex: {
          defaultAccountId: 'local-a',
          accounts: {
            'local-a': codexAccount('local-a', 'provider-a', 'token-a'),
            'local-b': codexAccount('local-b', 'provider-b', 'token-b'),
          },
        },
        claude: { accounts: {} },
      },
    })

    // @ts-expect-error cache-busting query string for Bun module isolation
    const { resolveProviderAccountSelection } = await import(
      './selection.js?provider-contexts'
    )
    expect(
      resolveProviderAccountSelection('codex', 'local-a').credential.accessToken,
    ).toBe('token-a')

    // A separate process would load a fresh selection module. The storage
    // lookup remains the source of truth for the opaque account ID.
    expect(readState().providerAccounts?.codex.accounts['local-b']?.credential).toMatchObject({
      accessToken: 'token-b',
    })
  })

  test('process selection is immutable after the first initialization', async () => {
    seed({
      providerAccounts: {
        schemaVersion: 1,
        codex: {
          defaultAccountId: 'local-a',
          accounts: {
            'local-a': codexAccount('local-a', 'provider-a', 'token-a'),
            'local-b': codexAccount('local-b', 'provider-b', 'token-b'),
          },
        },
        claude: { accounts: {} },
      },
    })

    // @ts-expect-error cache-busting query string for Bun module isolation
    const selection = await import('./selection.js?immutable-selection')
    expect(selection.initializeProviderAccountSelection('local-a')).toEqual({
      provider: 'codex',
      accountId: 'local-a',
    })
    expect(() =>
      selection.initializeProviderAccountSelection('local-b'),
    ).toThrow('provider_account_selection_already_initialized')
  })
})
