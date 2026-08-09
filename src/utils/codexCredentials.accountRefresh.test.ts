import { afterEach, expect, mock, test } from 'bun:test'

import type { SecureStorageData } from './secureStorage/index.js'

function jwt(accountId: string, expiresAt = Date.now() - 60_000): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(expiresAt / 1000),
    chatgpt_account_id: accountId,
  })).toString('base64url')
  return `${header}.${payload}.signature`
}

function initialState(): SecureStorageData {
  const account = (localAccountId: string, providerSubjectId: string) => ({
    localAccountId,
    providerSubjectId,
    displayLabel: localAccountId,
    credential: {
      accessToken: jwt(providerSubjectId),
      refreshToken: `refresh-${localAccountId}`,
      accountId: providerSubjectId,
    },
    connectionState: 'connected' as const,
  })
  return {
    providerAccounts: {
      schemaVersion: 1,
      codex: {
        defaultAccountId: 'local-a',
        accounts: {
          'local-a': account('local-a', 'provider-a'),
          'local-b': account('local-b', 'provider-b'),
        },
      },
      claude: { accounts: {} },
    },
    codex: account('local-a', 'provider-a').credential,
  }
}

test('refreshing two Codex accounts concurrently persists both results independently', async () => {
  delete process.env.CLAUDE_CODE_SIMPLE
  delete process.env.CODEX_API_KEY
  let state = initialState()

  mock.module('./secureStorage/index.js', () => ({
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

  const originalFetch = globalThis.fetch
  globalThis.fetch = mock(async (_input, init) => {
    const body = init?.body instanceof URLSearchParams
      ? init.body
      : new URLSearchParams(String(init?.body ?? ''))
    const refreshToken = body.get('refresh_token')
    if (refreshToken === 'refresh-local-a' || refreshToken === 'refresh-local-b') {
      const suffix = refreshToken.endsWith('a') ? 'a' : 'b'
      return new Response(JSON.stringify({
        access_token: jwt(`provider-${suffix}`, Date.now() + 3_600_000),
        refresh_token: `next-refresh-${suffix}`,
        id_token: jwt(`provider-${suffix}`, Date.now() + 3_600_000),
      }), { status: 200 })
    }
    return new Response(JSON.stringify({ access_token: 'api-key' }), { status: 200 })
  }) as unknown as typeof fetch

  try {
    // @ts-expect-error cache-busting query string for Bun module mocks
    const { refreshCodexAccessTokenIfNeeded } = await import(
      './codexCredentials.js?account-refresh-isolation'
    )
    const [a, b] = await Promise.all([
      refreshCodexAccessTokenIfNeeded({ force: true, ignoreEnvironment: true, localAccountId: 'local-a' }),
      refreshCodexAccessTokenIfNeeded({ force: true, ignoreEnvironment: true, localAccountId: 'local-b' }),
    ])

    expect(a.credentials?.accessToken).toBeTruthy()
    expect(b.credentials?.accessToken).toBeTruthy()
    expect(state.providerAccounts?.codex.accounts['local-a'].credential.refreshToken)
      .toBe('next-refresh-a')
    expect(state.providerAccounts?.codex.accounts['local-b'].credential.refreshToken)
      .toBe('next-refresh-b')
  } finally {
    globalThis.fetch = originalFetch
  }
})

afterEach(() => {
  mock.restore()
})
