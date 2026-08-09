import { afterEach, describe, expect, mock, test } from 'bun:test'

import type { SecureStorageData } from '../secureStorage/index.js'

function codexCredential(accountId: string, accessToken: string) {
  return { accessToken, accountId }
}

function claudeCredential(accountId: string, accessToken = 'claude-token') {
  return {
    accessToken,
    scopes: ['user:inference'],
    accountId,
    riskAcceptance: {
      version: 1,
      acceptedAt: '2026-08-09T12:00:00.000Z',
      accountId,
    },
  }
}

function seededData(): SecureStorageData {
  return {
    providerAccounts: {
      schemaVersion: 1,
      codex: {
        defaultAccountId: 'local-1',
        accounts: {
          'local-1': {
            localAccountId: 'local-1',
            providerSubjectId: 'provider-1',
            displayLabel: 'Codex 1',
            credential: codexCredential('provider-1', 'token-1'),
            connectionState: 'connected',
          },
        },
      },
      claude: { accounts: {} },
    },
    codex: codexCredential('provider-1', 'token-1'),
  }
}

async function loadStore(
  suffix: string,
  initial: SecureStorageData,
): Promise<{ store: typeof import('./store.js'); readState: () => SecureStorageData }> {
  let state = initial
  mock.module('../secureStorage/index.js', () => ({
    getSecureStorage: () => ({
      name: 'test-secure-storage',
      read: () => state,
      readAsync: async () => state,
      update: (next: SecureStorageData) => {
        state = next
        return { success: true }
      },
      delete: () => true,
    }),
  }))

  const store = await import(`./store.js?${suffix}`)
  return { store, readState: () => state }
}

afterEach(() => {
  mock.restore()
})

describe('provider account lifecycle', () => {
  test('repeated provider subject updates one local record and preserves its local id', async () => {
    const { store, readState } = await loadStore('dedupe', seededData())

    const result = store.upsertProviderAccount('codex', {
      accessToken: 'new-token',
      accountId: 'provider-1',
    })

    expect(result.localAccountId).toBe('local-1')
    expect(result.created).toBe(false)
    expect(readState().providerAccounts?.codex.accounts['local-1'].credential).toMatchObject({
      accessToken: 'new-token',
    })
    expect(Object.keys(readState().providerAccounts!.codex.accounts)).toEqual([
      'local-1',
    ])
  })

  test('changing default updates the legacy scalar but removing a non-default does not', async () => {
    const initial = seededData()
    initial.providerAccounts!.codex.accounts['local-2'] = {
      localAccountId: 'local-2',
      providerSubjectId: 'provider-2',
      displayLabel: 'Codex 2',
      credential: codexCredential('provider-2', 'token-2'),
      connectionState: 'connected',
    }
    const { store, readState } = await loadStore('default-mirror', initial)

    store.setDefaultProviderAccount('codex', 'local-2')
    expect(readState().codex?.accessToken).toBe('token-2')

    store.removeProviderAccount('codex', 'local-1')
    expect(readState().codex?.accessToken).toBe('token-2')
  })

  test('reconnect refuses to overwrite a different provider subject', async () => {
    const { store, readState } = await loadStore('identity-mismatch', seededData())

    expect(() =>
      store.reconnectProviderAccount(
        'codex',
        'local-1',
        codexCredential('provider-2', 'token-2'),
      ),
    ).toThrow('provider_identity_mismatch')
    expect(readState().providerAccounts?.codex.accounts['local-1'].credential).toMatchObject({
      accessToken: 'token-1',
      accountId: 'provider-1',
    })
  })

  test('removing the final account clears the mirrored scalar only after the v1 write succeeds', async () => {
    const { store, readState } = await loadStore('remove-final', seededData())

    store.removeProviderAccount('codex', 'local-1')

    expect(readState().providerAccounts?.codex.accounts).toEqual({})
    expect(readState().providerAccounts?.codex.defaultAccountId).toBeUndefined()
    expect(readState().codex).toBeUndefined()
  })

  test('a second provider login adds an account without replacing the first default', async () => {
    const { store, readState } = await loadStore('additive', seededData())

    const result = store.upsertProviderAccount(
      'claude',
      claudeCredential('provider-claude'),
    )

    expect(result.created).toBe(true)
    expect(Object.keys(readState().providerAccounts!.claude.accounts)).toHaveLength(1)
    expect(readState().providerAccounts!.claude.defaultAccountId).toBe(
      result.localAccountId,
    )
  })
})
