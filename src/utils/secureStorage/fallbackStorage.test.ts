import { describe, expect, test } from 'bun:test'
import { createFallbackStorage } from './fallbackStorage.js'
import type { SecureStorage, SecureStorageData } from './index.js'

function storage(readResult: NonNullable<SecureStorage['readResult']>): SecureStorage {
  return {
    name: 'fixture',
    read: () => null,
    readResult,
    readAsync: async () => null,
    update: () => ({ success: true }),
    delete: () => true,
  }
}

const data: SecureStorageData = { providerAccounts: { schemaVersion: 1, codex: { accounts: {} }, claude: { accounts: {} } } }

describe('fallback secure storage classification', () => {
  test('preserves a native read failure when the fallback is empty', () => {
    const primary = storage(() => ({ kind: 'error', warning: 'keychain unavailable' }))
    const secondary = storage(() => ({ kind: 'missing' }))
    expect(createFallbackStorage(primary, secondary).readResult?.()).toEqual({
      kind: 'error',
      warning: 'keychain unavailable',
    })
  })

  test('uses a valid fallback record when the native vault is unavailable', () => {
    const primary = storage(() => ({ kind: 'error', warning: 'keychain unavailable' }))
    const secondary = storage(() => ({ kind: 'ok', data }))
    expect(createFallbackStorage(primary, secondary).readResult?.()).toEqual({ kind: 'ok', data })
  })
})
