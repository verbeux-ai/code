import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import axios from 'axios'
import { join } from 'path'

import type { SecureStorageData } from './secureStorage/index.js'

let stored: SecureStorageData = {}
let refreshMode: 'success' | 'invalid_grant' | 'transient_error' = 'success'
let refreshCalls = 0
let storageWritesFail = false
let lockReleaseErrorCode: string | null = null
let refreshGate: Promise<void> | null = null
let markRefreshStarted: (() => void) | null = null
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
    lock: async () => async () => {
      if (lockReleaseErrorCode) {
        throw Object.assign(new Error('Lock is not acquired/owned by you'), {
          code: lockReleaseErrorCode,
        })
      }
    },
    lockSync: () => () => {},
  }))
  mock.module('../services/oauth/getOauthProfile.js', () => ({
    getOauthProfileFromOauthToken: async () => null,
  }))
  axios.post = mock(async () => {
    refreshCalls++
    markRefreshStarted?.()
    markRefreshStarted = null
    if (refreshGate) await refreshGate
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

test('does not abort a successful refresh when the lock was already released', async () => {
  stored = {
    verbooOauth: {
      accessToken: 'rejected-access-5',
      refreshToken: 'old-refresh-5',
      expiresAt: Date.now() + 600_000,
      scopes: ['user:profile', 'user:inference'],
    },
  }
  refreshMode = 'success'
  refreshCalls = 0
  storageWritesFail = false
  lockReleaseErrorCode = 'ENOTACQUIRED'

  // @ts-expect-error cache-busting query keeps module state isolated.
  const releaseRaceModule = await import('./auth.js?refresh-release-race')
  const { handleOAuth401ErrorWithOutcome } = releaseRaceModule

  try {
    const outcome = await handleOAuth401ErrorWithOutcome('rejected-access-5')

    expect(outcome).toBe('refreshed')
    expect(refreshCalls).toBe(1)
    expect(stored.verbooOauth?.accessToken).toBe('fresh-access')
  } finally {
    lockReleaseErrorCode = null
  }
})

test('does not hide an unexpected lock release failure', async () => {
  stored = {
    verbooOauth: {
      accessToken: 'rejected-access-unexpected-release',
      refreshToken: 'old-refresh-unexpected-release',
      expiresAt: Date.now() + 600_000,
      scopes: ['user:profile', 'user:inference'],
    },
  }
  refreshMode = 'success'
  refreshCalls = 0
  storageWritesFail = false
  lockReleaseErrorCode = 'EIO'

  // @ts-expect-error cache-busting query keeps module state isolated.
  const unexpectedReleaseModule = await import('./auth.js?unexpected-release')

  try {
    await expect(
      unexpectedReleaseModule.handleOAuth401ErrorWithOutcome(
        'rejected-access-unexpected-release',
      ),
    ).rejects.toMatchObject({ code: 'EIO' })
  } finally {
    lockReleaseErrorCode = null
  }
})

test('shares one refresh between an expiry check and a simultaneous 401', async () => {
  stored = {
    verbooOauth: {
      accessToken: 'rejected-access-6',
      refreshToken: 'old-refresh-6',
      expiresAt: Date.now() - 1,
      scopes: ['user:profile', 'user:inference'],
    },
  }
  refreshMode = 'success'
  refreshCalls = 0
  storageWritesFail = false
  lockReleaseErrorCode = null

  let releaseRefresh = () => {}
  refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve
  })
  const refreshStarted = new Promise<void>((resolve) => {
    markRefreshStarted = resolve
  })

  // @ts-expect-error cache-busting query keeps module state isolated.
  const singleFlightModule = await import('./auth.js?refresh-single-flight')
  const {
    checkAndRefreshOAuthTokenIfNeeded,
    handleOAuth401ErrorWithOutcome,
  } = singleFlightModule

  const expiryCheck = checkAndRefreshOAuthTokenIfNeeded()
  await refreshStarted
  const rejectedRequest = handleOAuth401ErrorWithOutcome('rejected-access-6')

  try {
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(refreshCalls).toBe(1)
  } finally {
    releaseRefresh()
    refreshGate = null
  }

  const [expiryRecovered, rejectionOutcome] = await Promise.all([
    expiryCheck,
    rejectedRequest,
  ])
  expect(expiryRecovered).toBe(true)
  expect(['refreshed', 'token_changed']).toContain(rejectionOutcome)
  expect(stored.verbooOauth?.accessToken).toBe('fresh-access')
})
