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
import { AccountWorkRegistry } from './providerAccounts/refreshRegistry.js'
import type { LocalProviderAccountId } from './providerAccounts/types.js'

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

type ClaudeRefreshResult = {
  refreshed: boolean
  credentials?: ClaudeNativeCredentialBlob
}

const claudeRefreshRegistry = new AccountWorkRegistry<ClaudeRefreshResult>()
const inMemoryLastRefreshFailureAt = new Map<string, number>()

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

export function readClaudeNativeCredentials(
  localAccountId?: LocalProviderAccountId,
): ClaudeNativeCredentialBlob | undefined {
  if (isBareMode()) return undefined
  try {
    const data = storage().read()
    const providerAccounts = normalizeProviderAccounts(data?.providerAccounts)
    const accountId = localAccountId ?? providerAccounts?.claude.defaultAccountId
    const account = accountId
      ? providerAccounts?.claude.accounts[accountId]
      : undefined
    if (account?.credential) return account.credential
    return normalizeClaudeNativeCredentials(data?.claudeNative)
  } catch {
    return undefined
  }
}

export async function readClaudeNativeCredentialsAsync(
  localAccountId?: LocalProviderAccountId,
): Promise<
  ClaudeNativeCredentialBlob | undefined
> {
  if (isBareMode()) return undefined
  try {
    const data = await storage().readAsync()
    const providerAccounts = normalizeProviderAccounts(data?.providerAccounts)
    const accountId = localAccountId ?? providerAccounts?.claude.defaultAccountId
    const account = accountId
      ? providerAccounts?.claude.accounts[accountId]
      : undefined
    if (account?.credential) return account.credential
    return normalizeClaudeNativeCredentials(data?.claudeNative)
  } catch {
    return undefined
  }
}

export function saveClaudeNativeCredentials(
  credentials: ClaudeNativeCredentialBlob,
  options?: { localAccountId?: LocalProviderAccountId; additive?: boolean },
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
  if (!providerAccounts && !options?.additive) {
    const next = {
      ...(previousData as Record<string, unknown>),
      [CLAUDE_NATIVE_STORAGE_KEY]: {
        ...normalized,
        lastRefreshAt: normalized.lastRefreshAt ?? Date.now(),
      },
    }
    const result = secureStorage.update(next as typeof previousData)
    if (result.success) {
      const key = accountRefreshKey(options?.localAccountId, normalized)
      if (normalized.lastRefreshFailureAt === undefined) {
        inMemoryLastRefreshFailureAt.delete(key)
      } else {
        inMemoryLastRefreshFailureAt.set(key, normalized.lastRefreshFailureAt)
      }
    }
    return result
  }

  try {
    upsertProviderAccount('claude', {
      ...normalized,
      lastRefreshAt: normalized.lastRefreshAt ?? Date.now(),
    }, { reconnectLocalAccountId: options?.localAccountId })
    const key = accountRefreshKey(options?.localAccountId, normalized)
    if (normalized.lastRefreshFailureAt === undefined) {
      inMemoryLastRefreshFailureAt.delete(key)
    } else {
      inMemoryLastRefreshFailureAt.set(key, normalized.lastRefreshFailureAt)
    }
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
      inMemoryLastRefreshFailureAt.clear()
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
  if (result.success) inMemoryLastRefreshFailureAt.clear()
  return result
}

function shouldRefresh(credentials: ClaudeNativeCredentialBlob): boolean {
  return (
    credentials.expiresAt !== undefined &&
    credentials.expiresAt <= Date.now() + REFRESH_SKEW_MS
  )
}

function accountRefreshKey(
  localAccountId: LocalProviderAccountId | undefined,
  credentials: ClaudeNativeCredentialBlob,
): string {
  return `claude:${localAccountId ?? credentials.accountId}`
}

function coolingDown(
  credentials: ClaudeNativeCredentialBlob,
  key: string,
): boolean {
  const failedAt = Math.max(
    credentials.lastRefreshFailureAt ?? 0,
    inMemoryLastRefreshFailureAt.get(key) ?? 0,
  )
  return Boolean(failedAt && Date.now() - failedAt < REFRESH_FAILURE_COOLDOWN_MS)
}

export async function refreshClaudeNativeAccessTokenIfNeeded(options?: {
  force?: boolean
  localAccountId?: LocalProviderAccountId
}): Promise<ClaudeRefreshResult> {
  const current = await readClaudeNativeCredentialsAsync(options?.localAccountId)
  if (!current || !hasCurrentClaudeRiskAcceptance(current)) {
    return { refreshed: false }
  }
  if (!current.refreshToken) return { refreshed: false, credentials: current }
  if (!options?.force && !shouldRefresh(current)) {
    return { refreshed: false, credentials: current }
  }
  const refreshKey = accountRefreshKey(options?.localAccountId, current)
  if (!options?.force && coolingDown(current, refreshKey)) {
    return { refreshed: false, credentials: current }
  }

  return claudeRefreshRegistry.run(refreshKey, async () => {
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
      const saved = saveClaudeNativeCredentials(next, {
        localAccountId: options?.localAccountId,
      })
      if (!saved.success) throw new Error(saved.warning)
      return { refreshed: true, credentials: next }
    } catch (error) {
      const failedAt = Date.now()
      inMemoryLastRefreshFailureAt.set(refreshKey, failedAt)
      saveClaudeNativeCredentials(
        { ...current, lastRefreshFailureAt: failedAt },
        { localAccountId: options?.localAccountId },
      )
      throw error
    }
  })
}
