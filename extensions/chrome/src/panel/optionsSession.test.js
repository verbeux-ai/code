import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loadOptionsSession } from './optionsSession.js'

test('loadOptionsSession: uses the service worker refreshed session', async () => {
  let storedRead = false
  const session = { accountId: 'account-1', accessToken: 'fresh-token' }
  const result = await loadOptionsSession({
    requestAuthState: async () => ({ ok: true, session }),
    loadStoredSession: async () => {
      storedRead = true
      return { accountId: 'account-1', accessToken: 'expired-token' }
    },
  })
  assert.deepEqual(result, session)
  assert.equal(storedRead, false)
})

test('loadOptionsSession: falls back to local storage when the worker is unavailable', async () => {
  const session = { accountId: 'account-1', accessToken: 'cached-token' }
  const result = await loadOptionsSession({
    requestAuthState: async () => ({ ok: false }),
    loadStoredSession: async () => session,
  })
  assert.deepEqual(result, session)
})
