import { expect, mock, test } from 'bun:test'

import {
  CLAUDE_NATIVE_AUTHORIZE_URL,
  CLAUDE_NATIVE_API_BASE_URL,
  CLAUDE_NATIVE_CLIENT_ID,
  CLAUDE_NATIVE_SCOPES,
  CLAUDE_NATIVE_TOKEN_URL,
} from './claudeNativeConfig.js'
import {
  buildClaudeNativeAuthorizeUrl,
  ClaudeNativeOAuthService,
  normalizeClaudePlanHint,
} from './claudeNativeOAuth.js'

test('accepts only explicit Pro or Max plan hints from the authenticated profile', () => {
  expect(normalizeClaudePlanHint({ id: 'max', display_name: 'Max' })).toEqual({
    id: 'max',
    displayName: 'Max',
  })
  expect(normalizeClaudePlanHint({ tier: 'pro' })).toEqual({
    id: 'pro',
    displayName: 'Pro',
  })
  expect(normalizeClaudePlanHint({ name: 'enterprise' })).toBeUndefined()
})

test('uses only the fixed native Claude OAuth endpoint and PKCE callback', () => {
  const value = buildClaudeNativeAuthorizeUrl({
    host: '127.0.0.1',
    port: 43123,
    codeChallenge: 'pkce-challenge',
    state: 'csrf-state',
  })
  const url = new URL(value)

  expect(url.origin + url.pathname).toBe(CLAUDE_NATIVE_AUTHORIZE_URL)
  expect(url.searchParams.get('client_id')).toBe(CLAUDE_NATIVE_CLIENT_ID)
  expect(url.searchParams.get('redirect_uri')).toBe(
    'http://127.0.0.1:43123/callback',
  )
  expect(url.searchParams.get('scope')).toBe(CLAUDE_NATIVE_SCOPES.join(' '))
  expect(url.searchParams.get('code_challenge')).toBe('pkce-challenge')
  expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  expect(url.searchParams.get('state')).toBe('csrf-state')
  expect(value).not.toContain('code.verboo.ai')
  expect(url.searchParams.has('installation_id')).toBe(false)
})

test('exchanges state-bound tokens and serves a local Verboo completion page', async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; body?: string }> = []
  let successBody = ''
  let pending = false
  const listener = {
    async start() {
      return 43123
    },
    hasPendingResponse() {
      return pending
    },
    async waitForAuthorization(
      _state: string,
      onReady: () => Promise<void>,
    ) {
      pending = true
      await onReady()
      return 'authorization-code'
    },
    handleSuccessRedirect(
      _scopes: string[],
      handler?: (response: {
        writeHead: (status: number, headers: Record<string, string>) => void
        end: (body: string) => void
      }) => void,
    ) {
      handler?.({
        writeHead: () => {},
        end: body => {
          successBody = body
          pending = false
        },
      })
    },
    handleErrorRedirect() {
      pending = false
    },
    cancelPendingAuthorization() {
      pending = false
    },
  }

  globalThis.fetch = mock(async (input, init) => {
    const url = String(input)
    requests.push({ url, body: init?.body?.toString() })
    if (url === CLAUDE_NATIVE_TOKEN_URL) {
      return Response.json({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
        scope: CLAUDE_NATIVE_SCOPES.join(' '),
        account: { uuid: 'account-1', email_address: 'user@example.com' },
      })
    }
    if (url === `${CLAUDE_NATIVE_API_BASE_URL}/api/oauth/profile`) {
      return Response.json({
        account: { uuid: 'account-1' },
        plan: { id: 'max', display_name: 'Max' },
      })
    }
    return new Response('unexpected request', { status: 500 })
  }) as unknown as typeof fetch

  try {
    const service = new ClaudeNativeOAuthService({
      callbackHost: '127.0.0.1',
      callbackPort: 43123,
      createAuthCodeListener: () => listener as never,
    })
    let authUrl = ''
    const tokens = await service.startOAuthFlow(async url => {
      authUrl = url
    })
    const state = new URL(authUrl).searchParams.get('state')
    const tokenForm = new URLSearchParams(requests[0]?.body)

    expect(tokens.accountId).toBe('account-1')
    expect(tokens.planId).toBe('max')
    expect(tokens.planDisplayName).toBe('Max')
    expect(requests.map(request => request.url)).toEqual([
      CLAUDE_NATIVE_TOKEN_URL,
      `${CLAUDE_NATIVE_API_BASE_URL}/api/oauth/profile`,
    ])
    expect(tokenForm.get('state')).toBe(state)
    expect(tokenForm.get('redirect_uri')).toBe(
      'http://127.0.0.1:43123/callback',
    )
    expect(successBody).toContain('voltar ao Verboo Code')
    expect(successBody).not.toContain('code.verboo.ai')
  } finally {
    globalThis.fetch = originalFetch
  }
})
