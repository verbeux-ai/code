import { expect, test } from 'bun:test'

import {
  buildClaudeApiKeyCredential,
  claudeApiKeyAccountId,
  isUsableClaudeCredential,
  looksLikeAnthropicApiKey,
  type ClaudeNativeCredentialBlob,
} from './claudeNativeCredentials.js'
import { normalizeClaudeNativeCredentials } from './providerAccounts/credentials.js'

const API_KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123'

const retiredOAuthLogin: ClaudeNativeCredentialBlob = {
  accessToken: 'oauth-token',
  scopes: ['user:inference'],
  accountId: 'account-1',
  riskAcceptance: {
    version: 1,
    acceptedAt: '2026-08-06T00:00:00.000Z',
    accountId: 'account-1',
  },
}

test('only an Anthropic API key is usable; the retired OAuth login never is', () => {
  expect(isUsableClaudeCredential(buildClaudeApiKeyCredential(API_KEY))).toBe(true)
  expect(isUsableClaudeCredential(retiredOAuthLogin)).toBe(false)
  expect(isUsableClaudeCredential(undefined)).toBe(false)
})

test('builds a stable, non-secret identity for the same key', () => {
  const first = buildClaudeApiKeyCredential(`  ${API_KEY}  `)
  const second = buildClaudeApiKeyCredential(API_KEY)
  expect(first).toEqual(second)
  expect(first.apiKey).toBe(API_KEY)
  expect(first.keyHint).toBe('0123')
  expect(first.accountId).toBe(claudeApiKeyAccountId(API_KEY))
  expect(first.accountId).not.toContain(API_KEY)
  expect(claudeApiKeyAccountId(`${API_KEY}x`)).not.toBe(first.accountId)
})

test('recognizes Anthropic API keys and rejects tokens or typos', () => {
  expect(looksLikeAnthropicApiKey(API_KEY)).toBe(true)
  expect(looksLikeAnthropicApiKey('sk-proj-abcdefghijklmnopqrstuvwxyz')).toBe(false)
  expect(looksLikeAnthropicApiKey('sk-ant-short')).toBe(false)
  expect(looksLikeAnthropicApiKey('')).toBe(false)
})

test('stored API keys and retired OAuth logins both still normalize', () => {
  // Retired logins must keep parsing so startup can find and remove them
  // without breaking normalization of the other providers' accounts.
  expect(normalizeClaudeNativeCredentials(buildClaudeApiKeyCredential(API_KEY))).toEqual(
    buildClaudeApiKeyCredential(API_KEY),
  )
  expect(normalizeClaudeNativeCredentials(retiredOAuthLogin)).toMatchObject({
    accessToken: 'oauth-token',
    accountId: 'account-1',
  })
  expect(
    normalizeClaudeNativeCredentials({ authType: 'api-key', apiKey: API_KEY }),
  ).toBeUndefined()
})
