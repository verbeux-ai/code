import { isBareMode } from './envUtils.js'
import { createCombinedAbortSignal } from './combinedAbortSignal.js'
import { getSecureStorage } from './secureStorage/index.js'
import {
  asTrimmedString,
  CODEX_REFRESH_URL,
  exchangeCodexIdTokenForApiKey,
  getCodexOAuthClientId,
  parseChatgptAccountId,
} from '../services/api/codexOAuthShared.js'
import {
  codexTokenExpiryMs,
  normalizeCodexCredentialBlob,
  type CodexCredentialBlob,
} from './providerAccounts/credentials.js'
import {
  removeProviderAccount,
  upsertProviderAccount,
} from './providerAccounts/store.js'
import { normalizeProviderAccounts } from './providerAccounts/store.js'
import { AccountWorkRegistry } from './providerAccounts/refreshRegistry.js'
import type { LocalProviderAccountId } from './providerAccounts/types.js'

export type { CodexCredentialBlob } from './providerAccounts/credentials.js'

export const CODEX_STORAGE_KEY = 'codex' as const
const CODEX_TOKEN_REFRESH_SKEW_MS = 60_000
const CODEX_TOKEN_REFRESH_RETRY_COOLDOWN_MS = 60_000

type CodexTokenRefreshResponse = {
  access_token?: string
  refresh_token?: string
  id_token?: string
}

type CodexRefreshResult = {
  refreshed: boolean
  credentials?: CodexCredentialBlob
}

const codexRefreshRegistry = new AccountWorkRegistry<CodexRefreshResult>()
const inMemoryLastRefreshFailureAt = new Map<string, number>()

function getCodexSecureStorage() {
  return getSecureStorage({ allowPlainTextFallback: false })
}

function shouldRefreshCodexToken(blob: CodexCredentialBlob): boolean {
  const expiresAt = codexTokenExpiryMs(blob)
  if (expiresAt === undefined) {
    return false
  }
  return expiresAt <= Date.now() + CODEX_TOKEN_REFRESH_SKEW_MS
}

function isWithinRefreshFailureCooldown(
  blob: CodexCredentialBlob,
  now = Date.now(),
  key = 'default',
): boolean {
  const lastRefreshFailureAt = Math.max(
    blob.lastRefreshFailureAt ?? 0,
    inMemoryLastRefreshFailureAt.get(key) ?? 0,
  )

  if (!lastRefreshFailureAt) {
    return false
  }

  return (
    now - lastRefreshFailureAt < CODEX_TOKEN_REFRESH_RETRY_COOLDOWN_MS
  )
}

function accountRefreshKey(
  localAccountId: LocalProviderAccountId | undefined,
  credentials: CodexCredentialBlob,
): string {
  return `codex:${localAccountId ?? credentials.accountId ?? 'default'}`
}

function getRefreshErrorMessage(
  status: number,
  bodyText: string,
): string {
  if (!bodyText.trim()) {
    return `Codex token refresh failed with status ${status}.`
  }

  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>
    const nestedError =
      parsed.error && typeof parsed.error === 'object'
        ? (parsed.error as Record<string, unknown>)
        : undefined
    const code = asTrimmedString(nestedError?.code ?? parsed.code)
    const message =
      asTrimmedString(nestedError?.message ?? parsed.error_description) ??
      bodyText.trim()
    return code
      ? `Codex token refresh failed (${code}): ${message}`
      : `Codex token refresh failed with status ${status}: ${message}`
  } catch {
    return `Codex token refresh failed with status ${status}: ${bodyText.trim()}`
  }
}

export function readCodexCredentials(
  localAccountId?: LocalProviderAccountId,
): CodexCredentialBlob | undefined {
  if (isBareMode()) return undefined

  try {
    const data = getCodexSecureStorage().read()
    const providerAccounts = normalizeProviderAccounts(data?.providerAccounts)
    const accountId = localAccountId ?? providerAccounts?.codex.defaultAccountId
    const account = accountId
      ? providerAccounts?.codex.accounts[accountId]
      : undefined
    if (account?.credential) return account.credential
    return normalizeCodexCredentialBlob(data?.codex)
  } catch {
    return undefined
  }
}

export async function readCodexCredentialsAsync(
  localAccountId?: LocalProviderAccountId,
): Promise<
  CodexCredentialBlob | undefined
> {
  if (isBareMode()) return undefined

  try {
    const data = await getCodexSecureStorage().readAsync()
    const providerAccounts = normalizeProviderAccounts(data?.providerAccounts)
    const accountId = localAccountId ?? providerAccounts?.codex.defaultAccountId
    const account = accountId
      ? providerAccounts?.codex.accounts[accountId]
      : undefined
    if (account?.credential) return account.credential
    return normalizeCodexCredentialBlob(data?.codex)
  } catch {
    return undefined
  }
}

export function isCodexRefreshFailureCoolingDown(
  blob: Pick<CodexCredentialBlob, 'lastRefreshFailureAt'>,
  now = Date.now(),
  localAccountId?: LocalProviderAccountId,
): boolean {
  return isWithinRefreshFailureCooldown(
    blob as CodexCredentialBlob,
    now,
    localAccountId ? `codex:${localAccountId}` : 'default',
  )
}

export function saveCodexCredentials(
  credentials: CodexCredentialBlob,
  options?: { localAccountId?: LocalProviderAccountId },
): { success: boolean; warning?: string } {
  if (isBareMode()) {
    return { success: false, warning: 'Bare mode: secure storage is disabled.' }
  }

  const normalized = normalizeCodexCredentialBlob(credentials)
  if (!normalized) {
    return { success: false, warning: 'Codex credentials are incomplete.' }
  }

  const secureStorage = getCodexSecureStorage()
  const previousData = secureStorage.read() || {}
  const providerAccounts = normalizeProviderAccounts(previousData.providerAccounts)
  if (!providerAccounts) {
    const previousCodex = normalizeCodexCredentialBlob(previousData[CODEX_STORAGE_KEY])
    const next = {
      ...(previousData as Record<string, unknown>),
      [CODEX_STORAGE_KEY]: {
        ...normalized,
        profileId: normalized.profileId ?? previousCodex?.profileId,
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

  const previous = readCodexCredentials(options?.localAccountId)
  try {
    upsertProviderAccount('codex', {
      ...normalized,
      profileId: normalized.profileId ?? previous?.profileId,
      lastRefreshAt: normalized.lastRefreshAt ?? Date.now(),
    }, options)
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

export function attachCodexProfileIdToStoredCredentials(profileId: string): {
  success: boolean
  warning?: string
} {
  if (isBareMode()) {
    return { success: false, warning: 'Bare mode: secure storage is disabled.' }
  }

  const current = readCodexCredentials()
  if (!current) {
    return {
      success: false,
      warning: 'Codex credentials are not stored securely yet.',
    }
  }

  return saveCodexCredentials({
    ...current,
    profileId,
  })
}

function persistCodexRefreshFailure(
  credentials: CodexCredentialBlob,
  occurredAt: number,
  localAccountId?: LocalProviderAccountId,
): void {
  const result = saveCodexCredentials({
    ...credentials,
    lastRefreshFailureAt: occurredAt,
  }, { localAccountId })
  if (!result.success) {
    inMemoryLastRefreshFailureAt.set(
      accountRefreshKey(localAccountId, credentials),
      occurredAt,
    )
  }
}

export function clearCodexCredentials(): {
  success: boolean
  warning?: string
} {
  if (isBareMode()) {
    return { success: true }
  }

  const raw = getCodexSecureStorage().read() || {}
  const providerAccounts = normalizeProviderAccounts(raw.providerAccounts)
  const defaultAccountId = providerAccounts?.codex.defaultAccountId
  if (defaultAccountId) {
    try {
      removeProviderAccount('codex', defaultAccountId)
      inMemoryLastRefreshFailureAt.clear()
      return { success: true }
    } catch (error) {
      return {
        success: false,
        warning: error instanceof Error ? error.message : 'secure_storage_write_failed',
      }
    }
  }

  const secureStorage = getCodexSecureStorage()
  const previous = raw
  const next = { ...(previous as Record<string, unknown>) }
  delete next[CODEX_STORAGE_KEY]
  const result = secureStorage.update(next as typeof previous)
  if (result.success) inMemoryLastRefreshFailureAt.clear()
  return result
}

export async function refreshCodexAccessTokenIfNeeded(options?: {
  force?: boolean
  ignoreEnvironment?: boolean
  localAccountId?: LocalProviderAccountId
}): Promise<CodexRefreshResult> {
  if (isBareMode()) {
    return { refreshed: false }
  }

  if (!options?.ignoreEnvironment && process.env.CODEX_API_KEY?.trim()) {
    return { refreshed: false }
  }

  const current = await readCodexCredentialsAsync(options?.localAccountId)
  if (!current) {
    return { refreshed: false }
  }

  if (!current.refreshToken) {
    return { refreshed: false, credentials: current }
  }
  const refreshToken = current.refreshToken

  if (!options?.force && !shouldRefreshCodexToken(current)) {
    return { refreshed: false, credentials: current }
  }

  const refreshKey = accountRefreshKey(options?.localAccountId, current)
  if (!options?.force && isWithinRefreshFailureCooldown(current, Date.now(), refreshKey)) {
    return { refreshed: false, credentials: current }
  }

  return codexRefreshRegistry.run(refreshKey, async () => {
    const refreshAttemptedAt = Date.now()

    try {
      const body = new URLSearchParams({
        client_id: getCodexOAuthClientId(),
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      })

      const { signal, cleanup } = createCombinedAbortSignal(undefined, {
        timeoutMs: 15_000,
      })
      let payload: CodexTokenRefreshResponse
      try {
        const response = await fetch(CODEX_REFRESH_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
          signal,
        })

        if (!response.ok) {
          const bodyText = await response.text().catch(() => '')
          throw new Error(getRefreshErrorMessage(response.status, bodyText))
        }

        payload = (await response.json()) as CodexTokenRefreshResponse
      } finally {
        cleanup()
      }
      const accessToken = asTrimmedString(payload.access_token)
      if (!accessToken) {
        throw new Error(
          'Codex token refresh succeeded without a new access token.',
        )
      }

      const next: CodexCredentialBlob = {
        accessToken,
        refreshToken:
          asTrimmedString(payload.refresh_token) ?? current.refreshToken,
        idToken: asTrimmedString(payload.id_token) ?? current.idToken,
        accountId:
          parseChatgptAccountId(payload.id_token) ??
          parseChatgptAccountId(payload.access_token) ??
          current.accountId,
        lastRefreshAt: Date.now(),
      }

      const idTokenForExchange = next.idToken ?? current.idToken
      if (idTokenForExchange) {
        next.apiKey = await exchangeCodexIdTokenForApiKey(
          idTokenForExchange,
        ).catch(() => undefined)
      }

      const saveResult = saveCodexCredentials(next, {
        localAccountId: options?.localAccountId,
      })
      if (!saveResult.success) {
        throw new Error(
          saveResult.warning ??
            'Codex token refresh succeeded but credentials could not be saved.',
        )
      }

      return {
        refreshed: true,
        credentials: next,
      }
    } catch (error) {
      persistCodexRefreshFailure(
        current,
        refreshAttemptedAt,
        options?.localAccountId,
      )
      throw error
    }
  })
}
