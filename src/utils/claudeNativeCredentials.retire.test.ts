/**
 * Startup removes stored Claude subscription (OAuth) logins and keeps API
 * keys and every other provider's accounts. No static import of the module
 * under test so mock.module applies before it loads.
 */
import { afterEach, expect, mock, test } from 'bun:test'

import type { SecureStorageData } from './secureStorage/index.js'

const API_KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123'

function oauthLogin(accountId: string) {
  return {
    accessToken: 'oauth-token',
    scopes: ['user:inference'],
    accountId,
    riskAcceptance: {
      version: 1,
      acceptedAt: '2026-08-09T12:00:00.000Z',
      accountId,
    },
  }
}

function account(localAccountId: string, providerSubjectId: string, credential: unknown) {
  return {
    localAccountId,
    providerSubjectId,
    displayLabel: localAccountId,
    credential,
    connectionState: 'connected',
  }
}

async function load(suffix: string, initial: SecureStorageData) {
  let state = initial
  mock.module('./secureStorage/index.js', () => ({
    getSecureStorage: () => ({
      name: 'test-secure-storage',
      read: () => state,
      readAsync: async () => state,
      readResult: () => ({ kind: 'ok', data: state }),
      update: (next: SecureStorageData) => {
        state = next
        return { success: true }
      },
      delete: () => true,
    }),
  }))
  mock.module('./lockfile.js', () => ({ lockSync: () => () => undefined }))
  mock.module('./envUtils.js', () => ({
    isBareMode: () => false,
    getClaudeConfigHomeDir: () => '/tmp/verboo-claude-retire-test',
  }))
  mock.module('./fsOperations.js', () => ({
    getFsImplementation: () => ({ mkdirSync: () => undefined }),
  }))
  const credentials = await import(`./claudeNativeCredentials.js?${suffix}`)
  return { credentials, readState: () => state }
}

afterEach(() => {
  mock.restore()
})

test('removes Claude OAuth logins and keeps API keys and Codex accounts', async () => {
  const { credentials, readState } = await load('mixed', {
    providerAccounts: {
      schemaVersion: 1,
      codex: {
        defaultAccountId: 'codex-1',
        accounts: {
          'codex-1': account('codex-1', 'provider-1', { accessToken: 'codex-token', accountId: 'provider-1' }),
        },
      },
      claude: {
        defaultAccountId: 'claude-oauth',
        accounts: {
          'claude-oauth': account('claude-oauth', 'claude-account', oauthLogin('claude-account')),
        },
      },
    },
    claudeNative: oauthLogin('claude-account'),
  } as unknown as SecureStorageData)

  const key = credentials.buildClaudeApiKeyCredential(API_KEY)
  const store = await import('./providerAccounts/store.js')
  store.upsertProviderAccount('claude', key)
  store.setDefaultProviderAccount(
    'claude',
    store.resolveProviderAccount('claude', key.accountId)?.localAccountId ??
      Object.keys(store.readProviderAccounts().claude.accounts).find(id => id !== 'claude-oauth')!,
  )

  const result = credentials.retireClaudeOAuthCredentials()
  expect(result).toEqual({ removed: 1 })

  const state = readState() as unknown as {
    providerAccounts: {
      codex: { accounts: Record<string, unknown> }
      claude: { defaultAccountId?: string; accounts: Record<string, { credential: { authType?: string } }> }
    }
    claudeNative?: { authType?: string }
  }
  expect(Object.keys(state.providerAccounts.codex.accounts)).toEqual(['codex-1'])
  const claudeAccounts = Object.values(state.providerAccounts.claude.accounts)
  expect(claudeAccounts).toHaveLength(1)
  expect(claudeAccounts[0]?.credential.authType).toBe('api-key')
  expect(state.claudeNative?.authType).toBe('api-key')
  expect(await credentials.readClaudeNativeCredentialsAsync()).toMatchObject({
    authType: 'api-key',
    apiKey: API_KEY,
  })

  // Idempotent: nothing left to remove on the next start.
  expect(credentials.retireClaudeOAuthCredentials()).toEqual({ removed: 0 })
})

test('a legacy single-blob OAuth login is removed and never read', async () => {
  const { credentials, readState } = await load('legacy', {
    claudeNative: oauthLogin('legacy-account'),
  } as unknown as SecureStorageData)

  expect(credentials.readClaudeNativeCredentials()).toBeUndefined()
  expect(credentials.retireClaudeOAuthCredentials()).toEqual({ removed: 1 })
  expect((readState() as Record<string, unknown>).claudeNative).toBeUndefined()
})

test('connecting a new key replaces every stored Claude login, and logout removes them all', async () => {
  const { credentials, readState } = await load('replace', {
    providerAccounts: {
      schemaVersion: 1,
      codex: { accounts: {} },
      claude: {
        defaultAccountId: 'claude-oauth',
        accounts: {
          'claude-oauth': account('claude-oauth', 'claude-account', oauthLogin('claude-account')),
        },
      },
    },
  } as unknown as SecureStorageData)
  const claudeAccounts = () =>
    Object.values(
      (readState() as unknown as {
        providerAccounts: { claude: { accounts: Record<string, { credential: { apiKey?: string } }> } }
      }).providerAccounts.claude.accounts,
    )

  const first = credentials.buildClaudeApiKeyCredential(API_KEY)
  const second = credentials.buildClaudeApiKeyCredential(`${API_KEY}-rotated`)
  expect(credentials.saveClaudeNativeCredentials(first).success).toBe(true)
  expect(credentials.saveClaudeNativeCredentials(second).success).toBe(true)

  expect(claudeAccounts().map(item => item.credential.apiKey)).toEqual([second.apiKey])
  expect((await credentials.readClaudeNativeCredentialsAsync())?.apiKey).toBe(second.apiKey)

  expect(credentials.clearClaudeNativeCredentials().success).toBe(true)
  expect(claudeAccounts()).toEqual([])
  expect(await credentials.readClaudeNativeCredentialsAsync()).toBeUndefined()
})
