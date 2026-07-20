import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import axios from 'axios'
import { join } from 'path'

import type { SecureStorageData } from './secureStorage/index.js'

let stored: SecureStorageData = {}
let refreshMode: 'success' | 'invalid_grant' | 'transient_error' = 'success'
let refreshCalls = 0
let storageWritesFail = false
const originalAxiosPost = axios.post

beforeAll(() => {
  process.env.VERBOO_CONFIG_DIR = join('/tmp', 'verboo-auth-refresh-test')

  mock.module('./secureStorage/index.js', () => ({
    getSecureStorage: () => ({
      name: 'test-storage',
      read: () => stored,
      readAsync: async () => stored,
      update: (data: SecureStorageData) => {
        if (storageWritesFail) return { success: false }
        stored = structuredClone(data)
        return { success: true }
      },
      delete: () => true,
    }),
  }))
  mock.module('./lockfile.js', () => ({
    lock: async () => async () => {},
  }))
  mock.module('../services/oauth/getOauthProfile.js', () => ({
    getOauthProfileFromOauthToken: async () => null,
  }))
  axios.post = mock(async () => {
    refreshCalls++
    if (refreshMode === 'invalid_grant') {
      throw Object.assign(new Error('invalid_grant'), {
        response: { data: { error: 'invalid_grant' } },
      })
    }
    if (refreshMode === 'transient_error') {
      throw new Error('refresh network timeout')
    }
    return {
      status: 200,
      data: {
        access_token: 'fresh-access',
        refresh_token: 'fresh-refresh',
        expires_in: 900,
        scope: 'user:profile user:inference',
      },
    }
  }) as typeof axios.post
})

afterAll(() => {
  mock.restore()
  axios.post = originalAxiosPost
  delete process.env.VERBOO_CONFIG_DIR
})

test('server 401 forces refresh even when local expiry says token is valid', async () => {
  stored = {
    verbooOauth: {
      accessToken: 'rejected-access',
      refreshToken: 'old-refresh',
      expiresAt: Date.now() + 600_000,
      scopes: ['user:profile', 'user:inference'],
    },
  }
  refreshMode = 'success'
  refreshCalls = 0
  storageWritesFail = false

  // @ts-expect-error cache-busting query keeps module state isolated.
  const { handleOAuth401ErrorWithOutcome } = await import('./auth.js?refresh-force')
  const outcome = await handleOAuth401ErrorWithOutcome('rejected-access')

  expect(outcome).toBe('refreshed')
  expect(refreshCalls).toBe(1)
  expect(stored.verbooOauth?.accessToken).toBe('fresh-access')
  expect(stored.verbooOauth?.refreshToken).toBe('fresh-refresh')
})

test('definitive invalid_grant clears only the unchanged stale session', async () => {
  stored = {
    verbooOauth: {
      accessToken: 'rejected-access-2',
      refreshToken: 'revoked-refresh',
      expiresAt: Date.now() + 600_000,
      scopes: ['user:profile', 'user:inference'],
    },
  }
  refreshMode = 'invalid_grant'
  refreshCalls = 0
  storageWritesFail = false

  // @ts-expect-error cache-busting query keeps module state isolated.
  const { handleOAuth401ErrorWithOutcome } = await import('./auth.js?refresh-invalid-grant')
  const outcome = await handleOAuth401ErrorWithOutcome('rejected-access-2')

  expect(outcome).toBe('reauth_required')
  expect(refreshCalls).toBe(1)
  expect(stored.verbooOauth).toBeUndefined()
})

test('does not report success when rotated tokens cannot be persisted', async () => {
  stored = {
    verbooOauth: {
      accessToken: 'rejected-access-3',
      refreshToken: 'old-refresh-3',
      expiresAt: Date.now() + 600_000,
      scopes: ['user:profile', 'user:inference'],
    },
  }
  refreshMode = 'success'
  refreshCalls = 0
  storageWritesFail = true

  // @ts-expect-error cache-busting query keeps module state isolated.
  const { handleOAuth401ErrorWithOutcome } = await import('./auth.js?refresh-storage-error')
  const outcome = await handleOAuth401ErrorWithOutcome('rejected-access-3')

  expect(outcome).toBe('storage_error')
  expect(refreshCalls).toBe(1)
  expect(stored.verbooOauth?.refreshToken).toBe('old-refresh-3')
  storageWritesFail = false
})

test('preserves the stored session after a transient refresh failure', async () => {
  stored = {
    verbooOauth: {
      accessToken: 'rejected-access-4',
      refreshToken: 'old-refresh-4',
      expiresAt: Date.now() + 600_000,
      scopes: ['user:profile', 'user:inference'],
    },
  }
  refreshMode = 'transient_error'
  refreshCalls = 0
  storageWritesFail = false

  // @ts-expect-error cache-busting query keeps module state isolated.
  const { handleOAuth401ErrorWithOutcome } = await import('./auth.js?refresh-transient')
  const outcome = await handleOAuth401ErrorWithOutcome('rejected-access-4')

  expect(outcome).toBe('transient_error')
  expect(refreshCalls).toBe(1)
  expect(stored.verbooOauth?.accessToken).toBe('rejected-access-4')
  expect(stored.verbooOauth?.refreshToken).toBe('old-refresh-4')
})
