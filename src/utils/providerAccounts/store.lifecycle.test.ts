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
  options: {
    readError?: Error
    readResult?: { kind: 'ok'; data: SecureStorageData } | { kind: 'missing' } | { kind: 'error'; warning?: string }
    updateResult?: { success: boolean; warning?: string }
  } = {},
): Promise<{
  store: typeof import('./store.js')
  readState: () => SecureStorageData
  updateCalls: () => number
  lockCalls: () => number
}> {
  let state = initial
  let updateCalls = 0
  let lockCalls = 0
  mock.module('../secureStorage/index.js', () => ({
    getSecureStorage: () => ({
      name: 'test-secure-storage',
      read: () => {
        if (options.readError) throw options.readError
        return state
      },
      readAsync: async () => state,
      readResult: () => {
        if (options.readError) return { kind: 'error', warning: options.readError.message }
        return options.readResult ?? { kind: 'ok', data: state }
      },
      update: (next: SecureStorageData) => {
        updateCalls += 1
        if (options.updateResult && !options.updateResult.success) {
          return options.updateResult
        }
        state = next
        return { success: true }
      },
      delete: () => true,
    }),
  }))
  mock.module('../lockfile.js', () => ({
    lockSync: () => {
      lockCalls += 1
      return () => undefined
    },
  }))
  mock.module('../envUtils.js', () => ({
    getClaudeConfigHomeDir: () => '/tmp/verboo-provider-account-store-test',
  }))
  mock.module('../fsOperations.js', () => ({
    getFsImplementation: () => ({ mkdirSync: () => undefined }),
  }))

  const store = await import(`./store.js?${suffix}`)
  return {
    store,
    readState: () => state,
    updateCalls: () => updateCalls,
    lockCalls: () => lockCalls,
  }
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

  test('serializes provider account mutations across CLI processes', async () => {
    const { store, lockCalls } = await loadStore('cross-process-lock', seededData())

    store.upsertProviderAccount('codex', {
      accessToken: 'new-token',
      accountId: 'provider-1',
    })

    expect(lockCalls()).toBeGreaterThan(0)
  })

  test('fails closed when the secure store cannot be read', async () => {
    const { store, updateCalls } = await loadStore('read-failure', seededData(), {
      readError: new Error('keychain unavailable'),
    })

    expect(() =>
      store.upsertProviderAccount('codex', {
        accessToken: 'should-not-write',
        accountId: 'provider-1',
      }),
    ).toThrow('provider_storage_read_failed')
    expect(updateCalls()).toBe(0)
  })

  test('uses a fresh classified secure-store read instead of treating null as empty', async () => {
    const { store, updateCalls } = await loadStore('classified-read-failure', seededData(), {
      readResult: { kind: 'error', warning: 'keychain locked' },
    })

    expect(() => store.readProviderAccounts()).toThrow('provider_storage_read_failed')
    expect(updateCalls()).toBe(0)
  })

  test('does not expose a migrated account when migration persistence fails', async () => {
    const legacyOnly = seededData()
    delete legacyOnly.providerAccounts
    const { store, updateCalls } = await loadStore('migration-failure', legacyOnly, {
      updateResult: { success: false, warning: 'keychain denied write' },
    })

    expect(() => store.readProviderAccounts()).toThrow(
      'provider_storage_migration_failed',
    )
    expect(updateCalls()).toBe(1)
  })
})
