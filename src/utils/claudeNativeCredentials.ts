import { createCombinedAbortSignal } from './combinedAbortSignal.js'
import { isBareMode } from './envUtils.js'
import { getSecureStorage } from './secureStorage/index.js'
import {
  CLAUDE_NATIVE_CLIENT_ID,
  CLAUDE_NATIVE_SCOPES,
  CLAUDE_NATIVE_TOKEN_URL,
  CLAUDE_RISK_NOTICE_VERSION,
} from '../services/api/claudeNativeConfig.js'
import {
  normalizeClaudeNativeCredentials,
  type ClaudeNativeCredentialBlob,
  type ClaudeRiskAcceptance,
} from './providerAccounts/credentials.js'
import {
  removeProviderAccount,
  upsertProviderAccount,
} from './providerAccounts/store.js'
import { normalizeProviderAccounts } from './providerAccounts/store.js'

export type {
  ClaudeNativeCredentialBlob,
  ClaudeRiskAcceptance,
} from './providerAccounts/credentials.js'

export const CLAUDE_NATIVE_STORAGE_KEY = 'claudeNative' as const
const REFRESH_SKEW_MS = 60_000
const REFRESH_FAILURE_COOLDOWN_MS = 60_000

type RefreshResponse = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
}

let inFlightRefresh: Promise<{
  refreshed: boolean
  credentials?: ClaudeNativeCredentialBlob
}> | null = null
let inMemoryLastRefreshFailureAt: number | null = null

function trimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function storage() {
  return getSecureStorage({ allowPlainTextFallback: false })
}

export function hasCurrentClaudeRiskAcceptance(
  credentials: ClaudeNativeCredentialBlob | undefined,
): boolean {
  return Boolean(
    credentials &&
      credentials.riskAcceptance.version === CLAUDE_RISK_NOTICE_VERSION &&
      credentials.riskAcceptance.accountId === credentials.accountId,
  )
}

export function readClaudeNativeCredentials(): ClaudeNativeCredentialBlob | undefined {
  if (isBareMode()) return undefined
  try {
    const data = storage().read()
    const providerAccounts = normalizeProviderAccounts(data?.providerAccounts)
    const defaultAccountId = providerAccounts?.claude.defaultAccountId
    const account = defaultAccountId
      ? providerAccounts?.claude.accounts[defaultAccountId]
      : undefined
    if (account?.credential) return account.credential
    return normalizeClaudeNativeCredentials(data?.claudeNative)
  } catch {
    return undefined
  }
}

export async function readClaudeNativeCredentialsAsync(): Promise<
  ClaudeNativeCredentialBlob | undefined
> {
  if (isBareMode()) return undefined
  try {
    const data = await storage().readAsync()
    const providerAccounts = normalizeProviderAccounts(data?.providerAccounts)
    const defaultAccountId = providerAccounts?.claude.defaultAccountId
    const account = defaultAccountId
      ? providerAccounts?.claude.accounts[defaultAccountId]
      : undefined
    if (account?.credential) return account.credential
    return normalizeClaudeNativeCredentials(data?.claudeNative)
  } catch {
    return undefined
  }
}

export function saveClaudeNativeCredentials(
  credentials: ClaudeNativeCredentialBlob,
): { success: boolean; warning?: string } {
  if (isBareMode()) {
    return { success: false, warning: 'Bare mode: secure storage is disabled.' }
  }
  const normalized = normalizeClaudeNativeCredentials(credentials)
  if (!normalized || !hasCurrentClaudeRiskAcceptance(normalized)) {
    return {
      success: false,
      warning: 'As credenciais Claude ou o aceite de risco estão incompletos.',
    }
  }
  const secureStorage = storage()
  const previousData = secureStorage.read() || {}
  const providerAccounts = normalizeProviderAccounts(previousData.providerAccounts)
  if (!providerAccounts) {
    const next = {
      ...(previousData as Record<string, unknown>),
      [CLAUDE_NATIVE_STORAGE_KEY]: {
        ...normalized,
        lastRefreshAt: normalized.lastRefreshAt ?? Date.now(),
      },
    }
    const result = secureStorage.update(next as typeof previousData)
    if (result.success) inMemoryLastRefreshFailureAt = normalized.lastRefreshFailureAt ?? null
    return result
  }

  try {
    upsertProviderAccount('claude', {
      ...normalized,
      lastRefreshAt: normalized.lastRefreshAt ?? Date.now(),
    })
    inMemoryLastRefreshFailureAt = normalized.lastRefreshFailureAt ?? null
    return { success: true }
  } catch (error) {
    return {
      success: false,
      warning: error instanceof Error ? error.message : 'secure_storage_write_failed',
    }
  }
}

export function clearClaudeNativeCredentials(): {
  success: boolean
  warning?: string
} {
  if (isBareMode()) return { success: true }
  const raw = storage().read() || {}
  const providerAccounts = normalizeProviderAccounts(raw.providerAccounts)
  const defaultAccountId = providerAccounts?.claude.defaultAccountId
  if (defaultAccountId) {
    try {
      removeProviderAccount('claude', defaultAccountId)
      inMemoryLastRefreshFailureAt = null
      return { success: true }
    } catch (error) {
      return {
        success: false,
        warning: error instanceof Error ? error.message : 'secure_storage_write_failed',
      }
    }
  }

  const secureStorage = storage()
  const previous = raw
  const next = { ...(previous as Record<string, unknown>) }
  delete next[CLAUDE_NATIVE_STORAGE_KEY]
  const result = secureStorage.update(next as typeof previous)
  if (result.success) inMemoryLastRefreshFailureAt = null
  return result
}

function shouldRefresh(credentials: ClaudeNativeCredentialBlob): boolean {
  return (
    credentials.expiresAt !== undefined &&
    credentials.expiresAt <= Date.now() + REFRESH_SKEW_MS
  )
}

function coolingDown(credentials: ClaudeNativeCredentialBlob): boolean {
  const failedAt = Math.max(
    credentials.lastRefreshFailureAt ?? 0,
    inMemoryLastRefreshFailureAt ?? 0,
  )
  return Boolean(failedAt && Date.now() - failedAt < REFRESH_FAILURE_COOLDOWN_MS)
}

export async function refreshClaudeNativeAccessTokenIfNeeded(options?: {
  force?: boolean
}): Promise<{
  refreshed: boolean
  credentials?: ClaudeNativeCredentialBlob
}> {
  const current = await readClaudeNativeCredentialsAsync()
  if (!current || !hasCurrentClaudeRiskAcceptance(current)) {
    return { refreshed: false }
  }
  if (!current.refreshToken) return { refreshed: false, credentials: current }
  if (!options?.force && !shouldRefresh(current)) {
    return { refreshed: false, credentials: current }
  }
  if (!options?.force && coolingDown(current)) {
    return { refreshed: false, credentials: current }
  }
  if (inFlightRefresh) return inFlightRefresh

  inFlightRefresh = (async () => {
    try {
      const form = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken!,
        client_id: CLAUDE_NATIVE_CLIENT_ID,
        scope: CLAUDE_NATIVE_SCOPES.join(' '),
      })
      const { signal, cleanup } = createCombinedAbortSignal(undefined, {
        timeoutMs: 15_000,
      })
      let response: Response
      try {
        response = await fetch(CLAUDE_NATIVE_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form,
          signal,
        })
      } finally {
        cleanup()
      }
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).trim().slice(0, 500)
        throw new Error(
          detail
            ? `Falha ao renovar o login Claude (${response.status}): ${detail}`
            : `Falha ao renovar o login Claude (${response.status}).`,
        )
      }
      const payload = (await response.json()) as RefreshResponse
      const accessToken = trimmed(payload.access_token)
      if (!accessToken) {
        throw new Error('A renovação Claude não retornou um access token.')
      }
      const expiresIn = finiteNumber(payload.expires_in)
      const next: ClaudeNativeCredentialBlob = {
        ...current,
        accessToken,
        refreshToken: trimmed(payload.refresh_token) ?? current.refreshToken,
        expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : current.expiresAt,
        scopes: trimmed(payload.scope)?.split(/\s+/).filter(Boolean) ?? current.scopes,
        lastRefreshAt: Date.now(),
        lastRefreshFailureAt: undefined,
      }
      const saved = saveClaudeNativeCredentials(next)
      if (!saved.success) throw new Error(saved.warning)
      inMemoryLastRefreshFailureAt = null
      return { refreshed: true, credentials: next }
    } catch (error) {
      const failedAt = Date.now()
      inMemoryLastRefreshFailureAt = failedAt
      saveClaudeNativeCredentials({ ...current, lastRefreshFailureAt: failedAt })
      throw error
    } finally {
      inFlightRefresh = null
    }
  })()
  return inFlightRefresh
}
