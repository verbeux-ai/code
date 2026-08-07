/**
 * auth.js — Verboo session + model list for the Chrome extension.
 *
 * Mirrors desktop ModelService (model_service.rs):
 *   GET https://code.verboo.ai/router/v1/models
 *   Authorization: Bearer <OAuth access token>
 *
 * Session is stored in chrome.storage.local so it survives browser restart.
 * When chrome is undefined (Node unit tests), an in-memory Map is used.
 *
 * Multi-user: zero hardcoded accounts; identity comes from the OAuth response.
 */

import { OAUTH_CONFIG } from './oauthConfig.js'

export const ROUTER_URL = 'https://code.verboo.ai/router/v1/models'
export const STORAGE_KEY = 'verbooSession'
export const MODELS_CACHE_KEY = 'verbooModelsCache'
export const SELECTED_MODEL_KEY = 'verbooSelectedModelId'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * @typedef {Object} VerbooSession
 * @property {string} accountId
 * @property {string} [email]
 * @property {string} accessToken
 * @property {string} [refreshToken]
 * @property {number} [expiresAt]
 * @property {'oauth'} source
 */

/**
 * @typedef {Object} VerbooModel
 * @property {string} id
 * @property {string} name
 * @property {string} [displayName]
 * @property {boolean} [supportsVision]
 * @property {boolean} [supportsTools]
 * @property {string} [toolProtocol]
 * @property {string} [description]
 * @property {string} [provider]
 */

// ── chrome.storage.local with in-memory fallback (Node tests) ────

/** @type {Map<string, unknown>} */
const memoryStore = new Map()

function hasChromeStorage() {
  return typeof chrome !== 'undefined' && !!chrome?.storage?.local
}

/**
 * @param {string|string[]|Record<string, unknown>} keys
 * @returns {Promise<Record<string, unknown>>}
 */
async function storageGet(keys) {
  if (hasChromeStorage()) {
    return chrome.storage.local.get(keys)
  }
  const out = {}
  if (typeof keys === 'string') {
    if (memoryStore.has(keys)) out[keys] = memoryStore.get(keys)
  } else if (Array.isArray(keys)) {
    for (const k of keys) {
      if (memoryStore.has(k)) out[k] = memoryStore.get(k)
    }
  } else if (keys && typeof keys === 'object') {
    for (const k of Object.keys(keys)) {
      out[k] = memoryStore.has(k) ? memoryStore.get(k) : keys[k]
    }
  }
  return out
}

/**
 * @param {Record<string, unknown>} items
 */
async function storageSet(items) {
  if (hasChromeStorage()) {
    await chrome.storage.local.set(items)
    return
  }
  for (const [k, v] of Object.entries(items)) {
    memoryStore.set(k, v)
  }
}

/**
 * @param {string|string[]} keys
 */
async function storageRemove(keys) {
  if (hasChromeStorage()) {
    await chrome.storage.local.remove(keys)
    return
  }
  const list = Array.isArray(keys) ? keys : [keys]
  for (const k of list) memoryStore.delete(k)
}

// ── Public API ─────────────────────────────────────────────

/** Load session from chrome.storage.local. @returns {Promise<VerbooSession|null>} */
export async function loadSession() {
  try {
    const result = await storageGet(STORAGE_KEY)
    return /** @type {VerbooSession|null} */ (result[STORAGE_KEY] ?? null)
  } catch {
    return null
  }
}

/** Persist session. @param {VerbooSession|null} session */
export async function saveSession(session) {
  if (session) {
    await storageSet({ [STORAGE_KEY]: session })
  } else {
    await storageRemove(STORAGE_KEY)
  }
}

/** Logout — clear session, model cache, and selected model. */
export async function logout() {
  await storageRemove([STORAGE_KEY, MODELS_CACHE_KEY, SELECTED_MODEL_KEY])
}

/**
 * Signed in when accessToken is present and not expired.
 * @returns {Promise<boolean>}
 */
export async function isSignedIn() {
  const s = await loadSession()
  if (!s?.accessToken) return false
  if (s.expiresAt == null) return true
  return s.expiresAt > Date.now()
}

export function getAuthCapabilities(config = OAUTH_CONFIG) {
  return {
    methods: ['oauth'],
    oauthConfigured: Boolean(config?.clientId),
  }
}

/**
 * Start a user-initiated OAuth Authorization Code + PKCE flow.
 *
 * @param {{clientId: string, authorizeUrl: string, tokenUrl: string, scopes: readonly string[]}} [config]
 * @param {{identity?: typeof chrome.identity, fetch?: typeof fetch, crypto?: Crypto}} [dependencies]
 * @returns {Promise<VerbooSession>}
 */
export async function startOAuthLogin(config = OAUTH_CONFIG, dependencies = {}) {
  if (!config?.clientId) throw new Error('oauth_not_configured')

  const identity = dependencies.identity ?? globalThis.chrome?.identity
  const fetchImpl = dependencies.fetch ?? globalThis.fetch
  const cryptoImpl = dependencies.crypto ?? globalThis.crypto
  if (!identity?.getRedirectURL || !identity?.launchWebAuthFlow || !cryptoImpl?.subtle) {
    throw new Error('oauth_unavailable')
  }

  const redirectUri = identity.getRedirectURL('oauth/callback')
  const verifier = randomBase64Url(cryptoImpl, 48)
  const state = randomBase64Url(cryptoImpl, 32)
  const challenge = await sha256Base64Url(cryptoImpl, verifier)
  const authorizeUrl = new URL(config.authorizeUrl)
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('client_id', config.clientId)
  authorizeUrl.searchParams.set('redirect_uri', redirectUri)
  authorizeUrl.searchParams.set('scope', config.scopes.join(' '))
  authorizeUrl.searchParams.set('state', state)
  authorizeUrl.searchParams.set('code_challenge', challenge)
  authorizeUrl.searchParams.set('code_challenge_method', 'S256')

  const callbackValue = await identity.launchWebAuthFlow({
    interactive: true,
    url: authorizeUrl.toString(),
  })
  if (!callbackValue) throw new Error('oauth_invalid_redirect')
  const callbackUrl = new URL(callbackValue)
  const expectedRedirect = new URL(redirectUri)
  if (
    callbackUrl.origin !== expectedRedirect.origin ||
    callbackUrl.pathname !== expectedRedirect.pathname
  ) {
    throw new Error('oauth_invalid_redirect')
  }
  const oauthError = callbackUrl.searchParams.get('error')
  if (oauthError) throw new Error(`oauth_authorization_failed:${oauthError}`)
  if (callbackUrl.searchParams.get('state') !== state) throw new Error('oauth_state_mismatch')
  const code = callbackUrl.searchParams.get('code')
  if (!code) throw new Error('oauth_code_missing')

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  })
  const response = await fetchImpl(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  })
  if (!response.ok) throw new Error(`oauth_token_exchange_failed:${response.status}`)
  const token = await response.json()
  if (!token?.access_token || typeof token.access_token !== 'string') {
    throw new Error('oauth_access_token_missing')
  }

  const claims = readJwtClaims(token.id_token ?? token.access_token)
  const expiresIn = Number(token.expires_in)
  const accountId = firstNonEmpty(token.account_id, token.user_id, token.sub, claims.sub, claims.user_id) ??
    `oauth:${(await sha256Base64Url(cryptoImpl, token.access_token)).slice(0, 12)}`
  const session = {
    accountId,
    ...(firstNonEmpty(token.email, claims.email) ? { email: firstNonEmpty(token.email, claims.email) } : {}),
    accessToken: token.access_token,
    ...(typeof token.refresh_token === 'string' && token.refresh_token
      ? { refreshToken: token.refresh_token }
      : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0
      ? { expiresAt: Date.now() + expiresIn * 1000 }
      : {}),
    source: 'oauth',
  }

  await saveSession(session)
  return session
}

/**
 * Load models: serve from cache if fresh (<24h) unless forceRefresh.
 * Re-fetches with the session token when needed.
 *
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<VerbooModel[]>}
 */
export async function loadModels(forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await readModelsCache()
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return filterVisionModels(cached.models)
    }
  }

  const session = await ensureFreshSession()
  if (!session?.accessToken) {
    const cached = await readModelsCache()
    return filterVisionModels(cached?.models ?? [])
  }

  let models
  try {
    models = await fetchModelsFromRouter(session.accessToken)
  } catch (error) {
    if (error?.status !== 401 || !session.refreshToken) throw error
    const refreshed = await refreshSession()
    if (!refreshed?.accessToken) throw error
    models = await fetchModelsFromRouter(refreshed.accessToken)
  }
  await storageSet({
    [MODELS_CACHE_KEY]: { models, fetchedAt: Date.now() },
  })
  return models
}

/**
 * @param {string} modelId
 */
export async function selectModel(modelId) {
  if (!modelId || typeof modelId !== 'string') {
    throw new Error('modelId is required')
  }
  await storageSet({ [SELECTED_MODEL_KEY]: modelId })
}

/** @returns {Promise<string|null>} */
export async function getSelectedModelId() {
  try {
    const result = await storageGet(SELECTED_MODEL_KEY)
    return /** @type {string|null} */ (result[SELECTED_MODEL_KEY] ?? null)
  } catch {
    return null
  }
}

/**
 * Refresh an OAuth session through the same public client. Refresh-token
 * rotation is honored; providers that omit a replacement keep the old token.
 * @returns {Promise<VerbooSession|null>}
 */
export async function refreshSession(config = OAUTH_CONFIG, dependencies = {}) {
  const current = await loadSession()
  if (!current?.accessToken) return null
  if (!current.refreshToken) throw new Error('oauth_refresh_token_missing')
  if (!config?.clientId) throw new Error('oauth_not_configured')

  const fetchImpl = dependencies.fetch ?? globalThis.fetch
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: current.refreshToken,
    client_id: config.clientId,
  })
  const response = await fetchImpl(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  })
  if (!response.ok) throw new Error(`oauth_refresh_failed:${response.status}`)
  const token = await response.json()
  if (!token?.access_token || typeof token.access_token !== 'string') {
    throw new Error('oauth_access_token_missing')
  }

  const expiresIn = Number(token.expires_in)
  const session = {
    ...current,
    accessToken: token.access_token,
    refreshToken:
      typeof token.refresh_token === 'string' && token.refresh_token
        ? token.refresh_token
        : current.refreshToken,
    ...(Number.isFinite(expiresIn) && expiresIn > 0
      ? { expiresAt: Date.now() + expiresIn * 1000 }
      : { expiresAt: undefined }),
    source: 'oauth',
  }
  await saveSession(session)
  return session
}

/**
 * Return a session with enough remaining lifetime for a Router request.
 * Expired sessions without a refresh token are treated as signed out.
 *
 * @param {{minValidityMs?: number, config?: typeof OAUTH_CONFIG, dependencies?: {fetch?: typeof fetch}}} [options]
 * @returns {Promise<VerbooSession|null>}
 */
export async function ensureFreshSession(options = {}) {
  const current = await loadSession()
  if (!current?.accessToken) return null
  const minValidityMs = options.minValidityMs ?? 60_000
  if (current.expiresAt == null || current.expiresAt > Date.now() + minValidityMs) {
    return current
  }
  if (!current.refreshToken) {
    return current.expiresAt > Date.now() ? current : null
  }
  return refreshSession(options.config ?? OAUTH_CONFIG, options.dependencies ?? {})
}

// ── Router fetch + normalize ─────────────────────────────────

/**
 * @param {string} token
 * @returns {Promise<VerbooModel[]>}
 */
async function fetchModelsFromRouter(token) {
  const response = await fetch(ROUTER_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  })

  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`)
    error.status = response.status
    throw error
  }

  const payload = await response.json()
  const models = filterVisionModels(normalizeModels(payload))
  models.sort((a, b) => String(a.name).localeCompare(String(b.name)))
  return models
}

function filterVisionModels(models) {
  return Array.isArray(models)
    ? models.filter((model) => model?.supportsVision === true)
    : []
}

/**
 * @param {unknown} payload
 * @returns {VerbooModel[]}
 */
export function normalizeModels(payload) {
  let items = []
  if (Array.isArray(payload)) {
    items = payload
  } else if (payload && typeof payload === 'object' && Array.isArray(/** @type {any} */ (payload).data)) {
    items = /** @type {any} */ (payload).data
  }

  /** @type {VerbooModel[]} */
  const out = []
  for (const item of items) {
    const m = normalizeModel(item)
    if (m) out.push(m)
  }
  return out
}

/**
 * @param {unknown} item
 * @returns {VerbooModel|null}
 */
function normalizeModel(item) {
  if (!item || typeof item !== 'object') return null
  const obj = /** @type {Record<string, unknown>} */ (item)
  const id = typeof obj.id === 'string' ? obj.id : null
  if (!id) return null

  const displayName =
    (typeof obj.display_name === 'string' && obj.display_name) ||
    (typeof obj.displayName === 'string' && obj.displayName) ||
    (typeof obj.label === 'string' && obj.label) ||
    (typeof obj.name === 'string' && obj.name) ||
    id

  const supportsVision = detectVisionSupport(obj)
  const supportsTools = detectToolSupport(obj)
  const toolProtocol = firstStringFromObjectOrCapabilities(obj, [
    'tool_protocol',
    'toolProtocol',
    'function_calling_protocol',
  ])
  const description = firstString(obj, ['description', 'summary', 'tagline'])
  const provider = firstString(obj, ['provider_name', 'providerName', 'provider'])

  return {
    id,
    name: displayName,
    displayName,
    supportsVision: supportsVision === true,
    ...(typeof supportsTools === 'boolean' ? { supportsTools } : {}),
    ...(toolProtocol ? { toolProtocol } : {}),
    ...(description ? { description } : {}),
    ...(provider ? { provider } : {}),
  }
}

function detectToolSupport(obj) {
  const keys = [
    'supportsTools',
    'supports_tools',
    'toolCalling',
    'tool_calling',
    'functionCalling',
    'function_calling',
  ]
  for (const source of [obj, obj.capabilities]) {
    if (!source || typeof source !== 'object') continue
    for (const key of keys) {
      if (typeof source[key] === 'boolean') return source[key]
    }
    for (const key of ['supported_parameters', 'supportedParameters']) {
      const values = source[key]
      if (Array.isArray(values) && values.some((value) => value === 'tools' || value === 'tool_choice')) {
        return true
      }
    }
  }
  return undefined
}

function firstStringFromObjectOrCapabilities(obj, keys) {
  return firstString(obj, keys) || (
    obj.capabilities && typeof obj.capabilities === 'object'
      ? firstString(obj.capabilities, keys)
      : undefined
  )
}

/**
 * Resolve the model for a turn. A model explicitly sent by the panel wins when
 * it is present in the live catalog, eliminating the small persistence race
 * between changing the picker and immediately sending a prompt.
 * @param {VerbooModel[]} models
 * @param {string | null | undefined} requestedId
 * @param {string | null | undefined} storedId
 * @returns {VerbooModel | null}
 */
export function resolveModelSelection(models, requestedId, storedId) {
  const list = Array.isArray(models) ? models.filter((model) => model?.id) : []
  if (requestedId) {
    const requested = list.find((model) => model.id === requestedId)
    if (requested) return requested
  }
  if (storedId) {
    const stored = list.find((model) => model.id === storedId)
    if (stored) return stored
  }
  return list[0] ?? null
}

/**
 * Lightweight vision detection aligned with model_service.rs heuristics.
 * @param {Record<string, unknown>} obj
 * @returns {boolean|undefined}
 */
function detectVisionSupport(obj) {
  const boolKeys = [
    'supportsVision',
    'supports_vision',
    'vision',
    'hasVision',
    'has_vision',
    'supportsImages',
    'supports_images',
  ]
  for (const key of boolKeys) {
    if (typeof obj[key] === 'boolean') return /** @type {boolean} */ (obj[key])
  }

  const caps = obj.capabilities
  if (caps && typeof caps === 'object') {
    const c = /** @type {Record<string, unknown>} */ (caps)
    for (const key of boolKeys) {
      if (typeof c[key] === 'boolean') return /** @type {boolean} */ (c[key])
    }
  }

  const modalities = collectStrings(obj, ['input_modalities', 'inputModalities', 'modalities'])
  if (modalities.some((s) => s === 'image' || s === 'vision')) return true

  const idText = [obj.id, obj.display_name, obj.displayName, obj.label, obj.name]
    .filter((v) => typeof v === 'string')
    .join(' ')
    .toLowerCase()
  const tokens = idText.split(/[^a-z0-9]+/).filter(Boolean)
  if (tokens.some((t) => t === 'vision' || t === 'vl' || t === 'omni' || t === 'multimodal')) {
    return true
  }
  return undefined
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string[]} keys
 * @returns {string[]}
 */
function collectStrings(obj, keys) {
  /** @type {string[]} */
  const out = []
  for (const key of keys) {
    const v = obj[key]
    if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'string') out.push(item.toLowerCase())
      }
    } else if (typeof v === 'string') {
      out.push(v.toLowerCase())
    }
  }
  return out
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string[]} keys
 * @returns {string | undefined}
 */
function firstString(obj, keys) {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (value && typeof value === 'object') {
      const nested = /** @type {Record<string, unknown>} */ (value)
      for (const nestedKey of ['display_name', 'displayName', 'name', 'id']) {
        const nestedValue = nested[nestedKey]
        if (typeof nestedValue === 'string' && nestedValue.trim()) return nestedValue.trim()
      }
    }
  }
  return undefined
}

/**
 * @returns {Promise<{ models: VerbooModel[], fetchedAt: number } | null>}
 */
async function readModelsCache() {
  try {
    const result = await storageGet(MODELS_CACHE_KEY)
    const cached = result[MODELS_CACHE_KEY]
    if (
      cached &&
      typeof cached === 'object' &&
      Array.isArray(/** @type {any} */ (cached).models) &&
      typeof /** @type {any} */ (cached).fetchedAt === 'number'
    ) {
      return /** @type {{ models: VerbooModel[], fetchedAt: number }} */ (cached)
    }
    return null
  } catch {
    return null
  }
}

function randomBase64Url(cryptoImpl, size) {
  const bytes = new Uint8Array(size)
  cryptoImpl.getRandomValues(bytes)
  return bytesToBase64Url(bytes)
}

async function sha256Base64Url(cryptoImpl, value) {
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return bytesToBase64Url(new Uint8Array(digest))
}

function bytesToBase64Url(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function readJwtClaims(value) {
  if (typeof value !== 'string') return {}
  const payload = value.split('.')[1]
  if (!payload) return {}
  try {
    const base64 = payload.replaceAll('-', '+').replaceAll('_', '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    return JSON.parse(atob(padded))
  } catch {
    return {}
  }
}

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim()
}
