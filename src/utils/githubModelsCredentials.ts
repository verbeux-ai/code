import { isBareMode, isEnvTruthy } from './envUtils.js'
import { getSecureStorage, type SecureStorageData } from './secureStorage/index.js'
import { plainTextStorage } from './secureStorage/plainTextStorage.js'
import { exchangeForCopilotToken } from '../services/github/deviceFlow.js'

/** JSON key in the shared Verboo Code secure storage blob. */
export const GITHUB_MODELS_STORAGE_KEY = 'githubModels' as const
export const GITHUB_MODELS_HYDRATED_ENV_MARKER =
  'CLAUDE_CODE_GITHUB_TOKEN_HYDRATED' as const

// VERBOO-BRAND: o login GitHub Copilot foi removido do Verboo Code. Tokens
// salvos são ignorados e apagados na inicialização (purgeGithubModelsCredentials).
const GITHUB_MODELS_LOGIN_RETIRED = true

export type GithubModelsCredentialBlob = {
  accessToken: string
  oauthAccessToken?: string
}

type GithubTokenStatus = 'valid' | 'expired' | 'invalid_format'

function checkGithubTokenStatus(token: string): GithubTokenStatus {
  const expMatch = token.match(/exp=(\d+)/)
  if (expMatch) {
    const expSeconds = Number(expMatch[1])
    if (!Number.isNaN(expSeconds)) {
      return Date.now() >= expSeconds * 1000 ? 'expired' : 'valid'
    }
  }

  const parts = token.split('.')
  const looksLikeJwt =
    parts.length === 3 && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))
  if (looksLikeJwt) {
    try {
      const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/')
      const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
      const json = Buffer.from(padded, 'base64').toString('utf8')
      const parsed = JSON.parse(json)
      if (parsed && typeof parsed === 'object' && parsed.exp) {
        return Date.now() >= (parsed.exp as number) * 1000 ? 'expired' : 'valid'
      }
    } catch {
      return 'invalid_format'
    }
  }

  return 'invalid_format'
}

export function readGithubModelsToken(): string | undefined {
  if (GITHUB_MODELS_LOGIN_RETIRED) return undefined // VERBOO-BRAND
  if (isBareMode()) return undefined
  try {
    const data = getSecureStorage().read() as
      | ({ githubModels?: GithubModelsCredentialBlob } & Record<string, unknown>)
      | null
    const t = data?.githubModels?.accessToken?.trim()
    return t || undefined
  } catch {
    return undefined
  }
}

export async function readGithubModelsTokenAsync(): Promise<string | undefined> {
  if (GITHUB_MODELS_LOGIN_RETIRED) return undefined // VERBOO-BRAND
  if (isBareMode()) return undefined
  try {
    const data = (await getSecureStorage().readAsync()) as
      | ({ githubModels?: GithubModelsCredentialBlob } & Record<string, unknown>)
      | null
    const t = data?.githubModels?.accessToken?.trim()
    return t || undefined
  } catch {
    return undefined
  }
}

/**
 * If GitHub Models mode is on and no token is in the environment, copy the
 * stored token into process.env so the OpenAI shim and validation see it.
 */
export function hydrateGithubModelsTokenFromSecureStorage(): void {
  if (!isEnvTruthy(process.env.CLAUDE_CODE_USE_GITHUB)) {
    delete process.env[GITHUB_MODELS_HYDRATED_ENV_MARKER]
    return
  }
  if (process.env.GH_TOKEN?.trim()) {
    delete process.env[GITHUB_MODELS_HYDRATED_ENV_MARKER]
    return
  }
  if (process.env.GITHUB_TOKEN?.trim()) {
    delete process.env[GITHUB_MODELS_HYDRATED_ENV_MARKER]
    return
  }
  if (isBareMode()) {
    delete process.env[GITHUB_MODELS_HYDRATED_ENV_MARKER]
    return
  }
  const t = readGithubModelsToken()
  if (t) {
    process.env.GITHUB_TOKEN = t
    process.env[GITHUB_MODELS_HYDRATED_ENV_MARKER] = '1'
    return
  }
  delete process.env[GITHUB_MODELS_HYDRATED_ENV_MARKER]
}

/**
 * Startup auto-refresh for GitHub Models mode.
 *
 * If a stored Copilot token is expired/invalid and an OAuth token is present,
 * exchange the OAuth token for a fresh Copilot token and persist it.
 */
export async function refreshGithubModelsTokenIfNeeded(): Promise<boolean> {
  if (GITHUB_MODELS_LOGIN_RETIRED) return false // VERBOO-BRAND
  if (!isEnvTruthy(process.env.CLAUDE_CODE_USE_GITHUB)) {
    return false
  }
  if (isBareMode()) {
    return false
  }

  try {
    const secureStorage = getSecureStorage()
    const data = secureStorage.read() as
      | ({ githubModels?: GithubModelsCredentialBlob } & Record<string, unknown>)
      | null
    const blob = data?.githubModels
    const accessToken = blob?.accessToken?.trim() || ''
    const oauthToken = blob?.oauthAccessToken?.trim() || ''

    if (!accessToken && !oauthToken) {
      return false
    }

    const status = accessToken ? checkGithubTokenStatus(accessToken) : 'expired'
    if (status === 'valid') {
      if (!process.env.GITHUB_TOKEN?.trim() && !process.env.GH_TOKEN?.trim()) {
        process.env.GITHUB_TOKEN = accessToken
      }
      return false
    }

    if (!oauthToken) {
      return false
    }

    const refreshed = await exchangeForCopilotToken(oauthToken)
    const saved = saveGithubModelsToken(refreshed.token, oauthToken)
    if (!saved.success) {
      return false
    }

    process.env.GITHUB_TOKEN = refreshed.token
    return true
  } catch {
    return false
  }
}

export function saveGithubModelsToken(
  token: string,
  oauthToken?: string,
): {
  success: boolean
  warning?: string
} {
  if (isBareMode()) {
    return { success: false, warning: 'Bare mode: secure storage is disabled.' }
  }
  const trimmed = token.trim()
  if (!trimmed) {
    return { success: false, warning: 'Token is empty.' }
  }
  const secureStorage = getSecureStorage()
  const prev = secureStorage.read() || {}
  const prevGithubModels = (prev as Record<string, unknown>)[
    GITHUB_MODELS_STORAGE_KEY
  ] as GithubModelsCredentialBlob | undefined
  const oauthTrimmed = oauthToken?.trim()
  const mergedBlob: GithubModelsCredentialBlob = {
    accessToken: trimmed,
  }
  if (oauthTrimmed) {
    mergedBlob.oauthAccessToken = oauthTrimmed
  } else if (prevGithubModels?.oauthAccessToken?.trim()) {
    mergedBlob.oauthAccessToken = prevGithubModels.oauthAccessToken.trim()
  }
  const merged = {
    ...(prev as Record<string, unknown>),
    [GITHUB_MODELS_STORAGE_KEY]: mergedBlob,
  }
  return secureStorage.update(merged as typeof prev)
}

export function clearGithubModelsToken(): { success: boolean; warning?: string } {
  if (isBareMode()) {
    return { success: true }
  }
  const secureStorage = getSecureStorage()
  const prev = secureStorage.read() || {}
  const next = { ...(prev as Record<string, unknown>) }
  delete next[GITHUB_MODELS_STORAGE_KEY]
  return secureStorage.update(next as typeof prev)
}

/**
 * VERBOO-BRAND: removes a stored GitHub Copilot login from both the native
 * vault and the plain-text fallback file. Never throws; returns whether
 * anything was removed.
 */
export function purgeGithubModelsCredentials(): boolean {
  if (isBareMode()) return false
  let removed = false
  for (const storage of [
    getSecureStorage({ allowPlainTextFallback: false }),
    plainTextStorage,
  ]) {
    try {
      const prev = storage.read() as Record<string, unknown> | null
      if (!prev || !(GITHUB_MODELS_STORAGE_KEY in prev)) continue
      const next = { ...prev }
      delete next[GITHUB_MODELS_STORAGE_KEY]
      if (storage.update(next as SecureStorageData).success) removed = true
    } catch {
      // A missing or locked vault must not block startup.
    }
  }
  return removed
}
