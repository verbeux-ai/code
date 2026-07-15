/**
 * Native Verboo login must remain authoritative even when the invoking shell
 * inherited OAuth credentials from another tool.
 */
import { afterEach, expect, mock, test } from 'bun:test'

const originalOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
const originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN
const originalSimple = process.env.CLAUDE_CODE_SIMPLE

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

afterEach(() => {
  mock.restore()
  restoreEnv('CLAUDE_CODE_OAUTH_TOKEN', originalOauthToken)
  restoreEnv('ANTHROPIC_AUTH_TOKEN', originalAnthropicAuthToken)
  restoreEnv('CLAUDE_CODE_SIMPLE', originalSimple)
})

test('uses the stored Verboo login ahead of an inherited OAuth environment token', async () => {
  delete process.env.CLAUDE_CODE_SIMPLE
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'stale-parent-shell-token'
  process.env.ANTHROPIC_AUTH_TOKEN = 'another-parent-shell-token'

  mock.module('./secureStorage/index.js', () => ({
    getSecureStorage: () => ({
      name: 'mock-secure-storage',
      read: () => ({
        verbooOauth: {
          accessToken: 'fresh-interactive-login-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() + 3_600_000,
          scopes: ['user:profile', 'user:inference'],
        },
      }),
      readAsync: async () => ({
        verbooOauth: {
          accessToken: 'fresh-interactive-login-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() + 3_600_000,
          scopes: ['user:profile', 'user:inference'],
        },
      }),
      update: () => ({ success: true }),
      delete: () => true,
    }),
  }))

  // @ts-expect-error cache-busting query string keeps this test isolated.
  const {
    getAuthTokenSource,
    getClaudeAIOAuthTokens,
    getClaudeAIOAuthTokensAsync,
  } = await import('./auth.js?verboo-precedence=stored-login-wins')

  expect(getClaudeAIOAuthTokens()?.accessToken).toBe(
    'fresh-interactive-login-token',
  )
  expect((await getClaudeAIOAuthTokensAsync())?.accessToken).toBe(
    'fresh-interactive-login-token',
  )
  expect(getAuthTokenSource()).toEqual({
    source: 'claude.ai',
    hasToken: true,
  })
})
