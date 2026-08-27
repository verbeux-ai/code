import { afterEach, expect, test } from 'bun:test'

import { getCLIEntitlementDeniedMessage } from './cliEntitlement.js'
import {
  HEADLESS_UNAUTHENTICATED_MESSAGE,
  VERBOO_API_KEY_INVALID_MESSAGE,
  headlessSessionFailureError,
  readHeadlessVerbooApiKey,
  validateVerbooApiKey,
} from './verbooStartupAuth.js'

test('explains each denied CLI entitlement without referring to router models', () => {
  expect(getCLIEntitlementDeniedMessage('past_due')).toContain(
    'pagamento pendente',
  )
  expect(getCLIEntitlementDeniedMessage('expired')).toContain('expirou')
  expect(getCLIEntitlementDeniedMessage('subscription_required')).toContain(
    'assinatura Verboo Code ativa',
  )
})

const originalApiKey = process.env.ANTHROPIC_API_KEY

afterEach(() => {
  if (originalApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  } else {
    process.env.ANTHROPIC_API_KEY = originalApiKey
  }
})

test('headless Verboo API key is read from ANTHROPIC_API_KEY when it is vbk_', () => {
  process.env.ANTHROPIC_API_KEY = 'vbk_from_env_key_ok'
  expect(readHeadlessVerbooApiKey()).toBe('vbk_from_env_key_ok')
})

test('headless Verboo API key ignores non-vbk env and uses the FD fallback', () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-not-a-verboo-key'
  expect(
    readHeadlessVerbooApiKey(() => 'vbk_from_fd_key_ok'),
  ).toBe('vbk_from_fd_key_ok')
})

test('headless Verboo API key is absent when neither env nor FD is vbk_', () => {
  delete process.env.ANTHROPIC_API_KEY
  expect(readHeadlessVerbooApiKey(() => null)).toBeUndefined()
})

test('validates vbk_ against the router models endpoint, not /api/me', async () => {
  const urls: string[] = []
  const result = await validateVerbooApiKey(
    'vbk_test_key_long_enough',
    async (url, config) => {
      urls.push(String(url))
      expect(
        (config as { headers: { Authorization: string } }).headers
          .Authorization,
      ).toBe('Bearer vbk_test_key_long_enough')
      return { status: 200, data: { data: [{ id: 'model' }] } }
    },
  )
  expect(result).toBe('ok')
  expect(urls[0]).toContain('/router/v1/models')
  expect(urls[0]).not.toContain('/api/me')
})

test('a 401 from the router marks the vbk_ key unauthorized', async () => {
  const result = await validateVerbooApiKey(
    'vbk_expired_or_wrong',
    async () => ({ status: 401, data: { error: 'invalid or expired token' } }),
  )
  expect(result).toBe('unauthorized')
})

test('headless failure with an invalid vbk_ is specific, not the OAuth login prompt', () => {
  expect(headlessSessionFailureError({ kind: 'invalid-api-key' }).message).toBe(
    VERBOO_API_KEY_INVALID_MESSAGE,
  )
  expect(VERBOO_API_KEY_INVALID_MESSAGE).toBe('API key inválida ou expirada')
  expect(
    headlessSessionFailureError({ kind: 'unauthenticated' }).message,
  ).toBe(HEADLESS_UNAUTHENTICATED_MESSAGE)
  expect(HEADLESS_UNAUTHENTICATED_MESSAGE).toContain('verboo /login')
  expect(HEADLESS_UNAUTHENTICATED_MESSAGE).not.toContain('API key')
})
