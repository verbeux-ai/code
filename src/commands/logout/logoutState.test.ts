import { expect, test } from 'bun:test'
import type {
  SecureStorage,
  SecureStorageData,
} from '../../utils/secureStorage/index.js'
import { removeStoredVerbooOauth } from './logoutState.js'

function storageFor(
  data: SecureStorageData,
  updateSucceeds = true,
): SecureStorage {
  return {
    name: 'test',
    read: () => data,
    readAsync: async () => data,
    update: (next) => {
      Object.assign(data, next)
      return { success: updateSucceeds }
    },
    delete: () => {
      Object.keys(data).forEach(
        (key) => delete data[key as keyof SecureStorageData],
      )
      return updateSucceeds
    },
  }
}

test('logout removes only Verboo OAuth credentials', () => {
  const data: SecureStorageData = {
    verbooOauth: {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60_000,
      scopes: ['user:inference'],
    },
    codex: { accessToken: 'codex-token' },
    mcpOAuth: {
      github: {
        serverName: 'GitHub',
        serverUrl: 'https://api.github.com',
        accessToken: 'mcp-token',
        expiresAt: Date.now() + 60_000,
      },
    },
  }

  const refreshToken = removeStoredVerbooOauth(storageFor(data))

  expect(refreshToken).toBe('refresh-token')
  expect(data.verbooOauth).toBeUndefined()
  expect(data.codex).toEqual({ accessToken: 'codex-token' })
  expect(data.mcpOAuth?.github?.accessToken).toBe('mcp-token')
})

test('logout fails instead of claiming success when local cleanup fails', () => {
  const data: SecureStorageData = {
    verbooOauth: {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60_000,
      scopes: ['user:inference'],
    },
  }

  expect(() => removeStoredVerbooOauth(storageFor(data, false))).toThrow(
    'Failed to clear local Verboo credentials',
  )
})
