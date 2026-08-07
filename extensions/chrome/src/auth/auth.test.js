/**
 * auth.test.js — unit tests for auth.js.
 *
 * The module ships with an in-memory chrome.storage.local fallback so
 * tests run under plain Node (no MV3 polyfill required).
 *
 * Run with: node --test src/auth/auth.test.js
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OAUTH_CONFIG } from './oauthConfig.js'

import {
  loadSession,
  saveSession,
  logout,
  isSignedIn,
  startOAuthLogin,
  refreshSession,
  ensureFreshSession,
  getAuthCapabilities,
  loadModels,
  selectModel,
  getSelectedModelId,
  normalizeModels,
  resolveModelSelection,
  STORAGE_KEY,
  MODELS_CACHE_KEY,
  SELECTED_MODEL_KEY,
  ROUTER_URL,
} from './auth.js'

// ── Storage keys ────────────────────────────────────────────

test('exports the expected storage key names (multi-user, no hardcoding)', () => {
  assert.equal(STORAGE_KEY, 'verbooSession')
  assert.equal(MODELS_CACHE_KEY, 'verbooModelsCache')
  assert.equal(SELECTED_MODEL_KEY, 'verbooSelectedModelId')
  assert.match(ROUTER_URL, /^https:\/\/code\.verboo\.ai\/router\/v1\/models$/)
})

// ── normalizeModels (pure) ──────────────────────────────────

test('normalizeModels: accepts OpenAI / Router shape { data: [...] }', () => {
  const out = normalizeModels({
    data: [
      { id: 'gpt-4o', display_name: 'GPT-4o', supports_vision: true },
      { id: 'gpt-4', display_name: 'GPT-4' },
    ],
  })
  assert.equal(out.length, 2)
  assert.equal(out[0].id, 'gpt-4o')
  assert.equal(out[0].displayName, 'GPT-4o')
  assert.equal(out[0].supportsVision, true)
  assert.equal(out[1].supportsVision, false)
})

test('normalizeModels: preserves optional presentation metadata from the router', () => {
  const [model] = normalizeModels({
    data: [{
      id: 'visual-1',
      display_name: 'Visual One',
      description: 'Fast visual reasoning',
      provider: { name: 'Example Provider' },
      supports_vision: true,
    }],
  })
  assert.equal(model.description, 'Fast visual reasoning')
  assert.equal(model.provider, 'Example Provider')
})

test('normalizeModels: preserves explicit browser tool protocol capabilities', () => {
  const models = normalizeModels({ data: [
    {
      id: 'tool-model',
      capabilities: { supports_tools: true, tool_protocol: 'openai' },
    },
    {
      id: 'text-model',
      capabilities: { supports_tools: false },
    },
  ] })
  assert.equal(models[0].supportsTools, true)
  assert.equal(models[0].toolProtocol, 'openai')
  assert.equal(models[1].supportsTools, false)
})

test('resolveModelSelection: current panel choice wins over stale persisted choice', () => {
  const models = normalizeModels({ data: [
    { id: 'kimi-k2.7', supports_vision: true },
    { id: 'minimax-m3', supports_vision: true },
  ] })
  const resolved = resolveModelSelection(models, 'kimi-k2.7', 'minimax-m3')
  assert.equal(resolved?.id, 'kimi-k2.7')
})

test('resolveModelSelection: invalid panel choice falls back safely', () => {
  const models = normalizeModels({ data: [
    { id: 'kimi-k2.7' },
    { id: 'minimax-m3' },
  ] })
  assert.equal(resolveModelSelection(models, 'unknown', 'minimax-m3')?.id, 'minimax-m3')
  assert.equal(resolveModelSelection(models, 'unknown', 'missing')?.id, 'kimi-k2.7')
})

test('normalizeModels: accepts top-level array', () => {
  const out = normalizeModels([{ id: 'm1' }, { id: 'm2', display_name: 'Two' }])
  assert.equal(out.length, 2)
  assert.equal(out[0].displayName, 'm1') // falls back to id
  assert.equal(out[1].displayName, 'Two')
})

test('normalizeModels: skips entries without id', () => {
  const out = normalizeModels({ data: [{ display_name: 'no id' }, { id: 'real' }] })
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 'real')
})

test('normalizeModels: vision detection from input_modalities', () => {
  const out = normalizeModels({
    data: [
      { id: 'a', input_modalities: ['text', 'image'] },
      { id: 'b', input_modalities: ['text'] },
    ],
  })
  assert.equal(out[0].supportsVision, true)
  assert.equal(out[1].supportsVision, false)
})

test('normalizeModels: vision detection from capabilities boolean flags', () => {
  const out = normalizeModels({
    data: [
      { id: 'a', capabilities: { supports_vision: true } },
      { id: 'b', capabilities: { supports_vision: false } },
    ],
  })
  assert.equal(out[0].supportsVision, true)
  assert.equal(out[1].supportsVision, false)
})

test('normalizeModels: vision detection from id-name heuristic', () => {
  const out = normalizeModels({ data: [
    { id: 'claude-3-5-sonnet-vision' },
    { id: 'minimax-vl-2' },
    { id: 'minimax-gpt-4-omni' },
    { id: 'minimax-gpt-4-mini' },
  ] })
  assert.equal(out[0].supportsVision, true)
  assert.equal(out[1].supportsVision, true)
  assert.equal(out[2].supportsVision, true)
  assert.equal(out[3].supportsVision, false)
})

test('normalizeModels: empty / invalid payload returns []', () => {
  assert.deepEqual(normalizeModels(null), [])
  assert.deepEqual(normalizeModels(undefined), [])
  assert.deepEqual(normalizeModels('garbage'), [])
  assert.deepEqual(normalizeModels({}), [])
})

// ── Session lifecycle (in-memory store) ─────────────────────

test('isSignedIn: false when no session', async () => {
  await logout() // ensure clean slate
  assert.equal(await isSignedIn(), false)
})

test('saveSession + loadSession roundtrip', async () => {
  await logout()
  await saveSession({
    accountId: 'user-1',
    accessToken: 'token-xyz',
    source: 'oauth',
    expiresAt: Date.now() + 60_000,
  })
  const s = await loadSession()
  assert.equal(s?.accountId, 'user-1')
  assert.equal(s?.accessToken, 'token-xyz')
  assert.equal(s?.source, 'oauth')
  assert.equal(await isSignedIn(), true)
})

test('isSignedIn: false when expired', async () => {
  await logout()
  await saveSession({
    accountId: 'expired-user',
    accessToken: 'token-x',
    source: 'oauth',
    expiresAt: Date.now() - 1_000, // already past
  })
  assert.equal(await isSignedIn(), false)
})

test('isSignedIn: true when expiresAt is omitted (no-expiry session)', async () => {
  await logout()
  await saveSession({
    accountId: 'no-exp-user',
    accessToken: 'token-x',
    source: 'oauth',
  })
  assert.equal(await isSignedIn(), true)
})

test('loadSession: returns stored blob as-is (no schema validation)', async () => {
  await saveSession({ foo: 'bar' })
  const s = await loadSession()
  assert.deepEqual(s, { foo: 'bar' })
  // Without accessToken, isSignedIn stays false
  assert.equal(await isSignedIn(), false)
})

test('logout: clears session + models cache + selected model', async () => {
  await saveSession({
    accountId: 'test-user',
    accessToken: 'token',
    source: 'oauth',
    expiresAt: Date.now() + 60_000,
  })
  await selectModel('m1')
  await logout()
  assert.equal(await isSignedIn(), false)
  assert.equal(await getSelectedModelId(), null)
})

// ── selectModel / getSelectedModelId ────────────────────────

test('selectModel + getSelectedModelId roundtrip', async () => {
  await logout()
  await selectModel('gpt-4o')
  assert.equal(await getSelectedModelId(), 'gpt-4o')
  await logout()
  assert.equal(await getSelectedModelId(), null)
})

test('selectModel: rejects empty / non-string id', async () => {
  await logout()
  await assert.rejects(() => selectModel(''), /modelId is required/)
  await assert.rejects(() => selectModel(null), /modelId is required/)
})

// ── OAuth PKCE ──────────────────────────────────────────────

/** @type {{ url: string, init: RequestInit } | null} */
let lastFetch = null
function mockFetchOnce(response) {
  /** @type {any} */
  const g = globalThis
  g.__origFetch = g.__origFetch ?? globalThis.fetch
  globalThis.fetch = async (url, init) => {
    lastFetch = { url: String(url), init: init ?? {} }
    return response
  }
}

function restoreFetch() {
  /** @type {any} */
  const g = globalThis
  if (g.__origFetch) {
    globalThis.fetch = g.__origFetch
    g.__origFetch = undefined
  }
}

const ROUTER_PAYLOAD = {
  data: [
    { id: 'vision-1', display_name: 'Vision One', supports_vision: true },
    { id: 'text-1', display_name: 'Text One' },
    { id: 'vision-2', display_name: 'Vision Two', supports_vision: true },
  ],
}

test('production auth advertises OAuth only', () => {
  assert.deepEqual(getAuthCapabilities().methods, ['oauth'])
})

test('release OAuth config exposes the registered Chrome public client', () => {
  assert.equal(OAUTH_CONFIG.clientId, 'verboo-code-chrome-extension')
  assert.equal(getAuthCapabilities().oauthConfigured, true)
})

test('OAuth uses identity + PKCE and persists only the returned session', async () => {
  await logout()
  let authorizeUrl = null
  const identity = {
    getRedirectURL: (path) => `https://extension-id.chromiumapp.org/${path}`,
    launchWebAuthFlow: async ({ url }) => {
      authorizeUrl = new URL(url)
      return `https://extension-id.chromiumapp.org/oauth/callback?code=auth-code&state=${authorizeUrl.searchParams.get('state')}`
    },
  }
  mockFetchOnce({
    ok: true,
    status: 200,
    json: async () => ({
      access_token: 'oauth-access',
      refresh_token: 'oauth-refresh',
      expires_in: 3600,
      account_id: 'account-7',
      email: 'user@example.com',
    }),
  })
  try {
    const session = await startOAuthLogin({
      clientId: 'chrome-client',
      authorizeUrl: 'https://code.verboo.ai/oauth/authorize',
      tokenUrl: 'https://code.verboo.ai/oauth/token',
      scopes: ['user:profile', 'user:inference'],
    }, { identity })

    assert.equal(authorizeUrl.searchParams.get('response_type'), 'code')
    assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256')
    assert.ok(authorizeUrl.searchParams.get('code_challenge'))
    assert.equal(lastFetch.url, 'https://code.verboo.ai/oauth/token')
    assert.match(String(lastFetch.init.body), /grant_type=authorization_code/)
    assert.match(String(lastFetch.init.body), /code_verifier=/)
    assert.equal(session.source, 'oauth')
    assert.equal(session.accountId, 'account-7')
    assert.equal(session.email, 'user@example.com')
    assert.equal((await loadSession())?.accessToken, 'oauth-access')
  } finally {
    restoreFetch()
  }
})

test('OAuth rejects a callback with a mismatched state before token exchange', async () => {
  let fetched = false
  await assert.rejects(
    () => startOAuthLogin({
      clientId: 'chrome-client',
      authorizeUrl: 'https://code.verboo.ai/oauth/authorize',
      tokenUrl: 'https://code.verboo.ai/oauth/token',
      scopes: ['user:profile'],
    }, {
      identity: {
        getRedirectURL: (path) => `https://extension-id.chromiumapp.org/${path}`,
        launchWebAuthFlow: async () =>
          'https://extension-id.chromiumapp.org/oauth/callback?code=auth-code&state=wrong',
      },
      fetch: async () => { fetched = true; throw new Error('must not fetch') },
    }),
    /oauth_state_mismatch/,
  )
  assert.equal(fetched, false)
})

test('refreshSession rotates the access token and preserves an omitted refresh token', async () => {
  await logout()
  await saveSession({
    accountId: 'refresh-user',
    email: 'refresh@example.com',
    accessToken: 'access-old',
    refreshToken: 'refresh-old',
    expiresAt: Date.now() - 1,
    source: 'oauth',
  })

  let request = null
  const refreshed = await refreshSession({
    clientId: 'chrome-client',
    authorizeUrl: 'https://code.verboo.ai/oauth/authorize',
    tokenUrl: 'https://code.verboo.ai/oauth/token',
    scopes: ['user:profile'],
  }, {
    fetch: async (url, init) => {
      request = { url: String(url), init }
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'access-new', expires_in: 3600 }),
      }
    },
  })

  assert.equal(request.url, 'https://code.verboo.ai/oauth/token')
  assert.match(String(request.init.body), /grant_type=refresh_token/)
  assert.match(String(request.init.body), /refresh_token=refresh-old/)
  assert.equal(refreshed.accessToken, 'access-new')
  assert.equal(refreshed.refreshToken, 'refresh-old')
  assert.equal(refreshed.accountId, 'refresh-user')
  assert.equal(refreshed.email, 'refresh@example.com')
  assert.ok(refreshed.expiresAt > Date.now())
  assert.equal((await loadSession()).accessToken, 'access-new')
})

test('ensureFreshSession refreshes before expiry and returns null when renewal is impossible', async () => {
  await logout()
  await saveSession({
    accountId: 'refresh-user',
    accessToken: 'access-old',
    refreshToken: 'refresh-old',
    expiresAt: Date.now() + 10_000,
    source: 'oauth',
  })

  let refreshCalls = 0
  const fresh = await ensureFreshSession({
    minValidityMs: 60_000,
    config: {
      clientId: 'chrome-client',
      authorizeUrl: 'https://code.verboo.ai/oauth/authorize',
      tokenUrl: 'https://code.verboo.ai/oauth/token',
      scopes: ['user:profile'],
    },
    dependencies: {
      fetch: async () => {
        refreshCalls += 1
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'access-fresh',
            refresh_token: 'refresh-rotated',
            expires_in: 120,
          }),
        }
      },
    },
  })
  assert.equal(refreshCalls, 1)
  assert.equal(fresh.accessToken, 'access-fresh')
  assert.equal(fresh.refreshToken, 'refresh-rotated')

  await saveSession({
    accountId: 'expired-without-refresh',
    accessToken: 'expired',
    expiresAt: Date.now() - 1,
    source: 'oauth',
  })
  assert.equal(await ensureFreshSession(), null)
})

// ── loadModels (uses cache via in-memory store) ─────────────

test('loadModels: empty when no session and no cache', async () => {
  await logout()
  const models = await loadModels(false)
  assert.deepEqual(models, [])
})

test('loadModels: uses cache when present', async () => {
  await logout()
  await saveSession({
    accountId: 'cached-user',
    accessToken: 'oauth-cached',
    source: 'oauth',
    expiresAt: Date.now() + 60_000,
  })
  // Seed cache via a forced refresh (saveModelsCache is not exported).
  mockFetchOnce({ ok: true, status: 200, json: async () => ROUTER_PAYLOAD })
  try {
    await loadModels(true)
  } finally {
    restoreFetch()
  }

  // loadModels(false) should serve the cache without calling fetch
  let fetchCalled = false
  mockFetchOnce({
    ok: true,
    status: 200,
    json: async () => {
      fetchCalled = true
      return { data: [] }
    },
  })
  try {
    const models = await loadModels(false)
    assert.equal(models.length, 2)
    assert.deepEqual(models.map((model) => model.id), ['vision-1', 'vision-2'])
    assert.equal(models[0].supportsVision, true)
    assert.equal(fetchCalled, false)
  } finally {
    restoreFetch()
  }
})

test('loadModels: fetches live when forceRefresh=true and persists cache', async () => {
  await logout()
  await saveSession({
    accountId: 'live-user',
    accessToken: 'oauth-live',
    source: 'oauth',
    expiresAt: Date.now() + 60_000,
  })
  mockFetchOnce({ ok: true, status: 200, json: async () => ROUTER_PAYLOAD })
  try {
    const models = await loadModels(true)
    assert.equal(models.length, 2)
    assert.deepEqual(models.map((model) => model.id), ['vision-1', 'vision-2'])
    assert.equal(models.every((model) => model.supportsVision), true)
  } finally {
    restoreFetch()
  }
})

test('loadModels: refreshes and retries once after an unauthorized catalog request', async () => {
  await logout()
  await saveSession({
    accountId: 'retry-user',
    accessToken: 'access-old',
    refreshToken: 'refresh-old',
    expiresAt: Date.now() + 5 * 60_000,
    source: 'oauth',
  })
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), authorization: init?.headers?.Authorization, body: String(init?.body ?? '') })
    if (String(url) === ROUTER_URL && requests.filter((r) => r.url === ROUTER_URL).length === 1) {
      return { ok: false, status: 401, text: async () => 'expired' }
    }
    if (String(url).endsWith('/oauth/token')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 }),
      }
    }
    return { ok: true, status: 200, json: async () => ROUTER_PAYLOAD }
  }
  try {
    const models = await loadModels(true)
    assert.equal(models.length, 2)
    assert.equal(models.every((model) => model.supportsVision), true)
    assert.deepEqual(
      requests.filter((request) => request.url === ROUTER_URL).map((request) => request.authorization),
      ['Bearer access-old', 'Bearer access-new'],
    )
    assert.match(requests.find((request) => request.url.endsWith('/oauth/token')).body, /grant_type=refresh_token/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
