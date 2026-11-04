import { createHash } from 'crypto'

import { isBareMode } from './envUtils.js'
import { getSecureStorage } from './secureStorage/index.js'
import {
  isClaudeApiKeyCredential,
  normalizeClaudeNativeCredentials,
  type ClaudeApiKeyCredentialBlob,
  type ClaudeNativeCredentialBlob,
} from './providerAccounts/credentials.js'
import {
  removeProviderAccount,
  setDefaultProviderAccount,
  upsertProviderAccount,
} from './providerAccounts/store.js'
import { normalizeProviderAccounts } from './providerAccounts/store.js'
import type { LocalProviderAccountId } from './providerAccounts/types.js'

export type {
  ClaudeApiKeyCredentialBlob,
  ClaudeNativeCredentialBlob,
} from './providerAccounts/credentials.js'

export const CLAUDE_NATIVE_STORAGE_KEY = 'claudeNative' as const

const STORAGE_FAILED_MESSAGE =
  'Não foi possível usar o armazenamento seguro do sistema. Confira se o chaveiro está desbloqueado e tente de novo.'

function storage() {
  return getSecureStorage({ allowPlainTextFallback: false })
}

/**
 * Only the user's own Anthropic API key can be used. The Claude subscription
 * login (OAuth with Claude Code's client id) was retired: Anthropic does not
 * allow third parties to offer Claude.ai login, so stored OAuth blobs are
 * treated as absent everywhere and removed by retireClaudeOAuthCredentials.
 */
export function isUsableClaudeCredential(
  credentials: ClaudeNativeCredentialBlob | undefined,
): credentials is ClaudeApiKeyCredentialBlob {
  return isClaudeApiKeyCredential(credentials)
}

/**
 * Stable, non-secret account identity for an API key, so re-adding the same
 * key reuses its account instead of creating a duplicate.
 */
export function claudeApiKeyAccountId(apiKey: string): string {
  const digest = createHash('sha256').update(apiKey.trim()).digest('hex')
  return `anthropic-key-${digest.slice(0, 16)}`
}

export function buildClaudeApiKeyCredential(
  apiKey: string,
): ClaudeApiKeyCredentialBlob {
  const trimmed = apiKey.trim()
  return {
    authType: 'api-key',
    apiKey: trimmed,
    accountId: claudeApiKeyAccountId(trimmed),
    keyHint: trimmed.slice(-4),
  }
}

/** Anthropic API keys start with sk-ant-; anything else is a typo or a token. */
export function looksLikeAnthropicApiKey(value: string): boolean {
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(value.trim())
}

function selectUsable(
  data: Record<string, unknown> | undefined,
  localAccountId: LocalProviderAccountId | undefined,
): ClaudeApiKeyCredentialBlob | undefined {
  const providerAccounts = normalizeProviderAccounts(data?.providerAccounts)
  const accountId = localAccountId ?? providerAccounts?.claude.defaultAccountId
  const account = accountId
    ? providerAccounts?.claude.accounts[accountId]
    : undefined
  const credential = account?.credential
    ?? normalizeClaudeNativeCredentials(data?.[CLAUDE_NATIVE_STORAGE_KEY])
  return isUsableClaudeCredential(credential) ? credential : undefined
}

export function readClaudeNativeCredentials(
  localAccountId?: LocalProviderAccountId,
): ClaudeApiKeyCredentialBlob | undefined {
  if (isBareMode()) return undefined
  try {
    return selectUsable(
      storage().read() as Record<string, unknown> | undefined,
      localAccountId,
    )
  } catch {
    return undefined
  }
}

export async function readClaudeNativeCredentialsAsync(
  localAccountId?: LocalProviderAccountId,
): Promise<ClaudeApiKeyCredentialBlob | undefined> {
  if (isBareMode()) return undefined
  try {
    return selectUsable(
      (await storage().readAsync()) as Record<string, unknown> | undefined,
      localAccountId,
    )
  } catch {
    return undefined
  }
}

/**
 * Connects the key as the one in use. Each key has its own account id, so a
 * rotated key would otherwise sit unused next to the old one, which must also
 * stop being stored.
 */
export function saveClaudeNativeCredentials(
  credentials: ClaudeApiKeyCredentialBlob,
): { success: boolean; localAccountId?: LocalProviderAccountId; warning?: string } {
  if (isBareMode()) {
    return { success: false, warning: 'Bare mode: secure storage is disabled.' }
  }
  const normalized = normalizeClaudeNativeCredentials(credentials)
  if (!isUsableClaudeCredential(normalized)) {
    return { success: false, warning: 'A chave de API da Anthropic está incompleta.' }
  }
  try {
    const { localAccountId } = upsertProviderAccount('claude', normalized)
    setDefaultProviderAccount('claude', localAccountId)
    const raw = storage().read() || {}
    const stored = normalizeProviderAccounts(raw.providerAccounts)
    for (const otherId of Object.keys(stored?.claude.accounts ?? {})) {
      if (otherId !== localAccountId) removeProviderAccount('claude', otherId)
    }
    return { success: true, localAccountId }
  } catch {
    return {
      success: false,
      warning: STORAGE_FAILED_MESSAGE,
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
  const accountIds = Object.keys(providerAccounts?.claude.accounts ?? {})
  if (accountIds.length > 0) {
    try {
      for (const accountId of accountIds) {
        removeProviderAccount('claude', accountId)
      }
      return { success: true }
    } catch {
      return {
        success: false,
        warning: STORAGE_FAILED_MESSAGE,
      }
    }
  }

  const next = { ...(raw as Record<string, unknown>) }
  delete next[CLAUDE_NATIVE_STORAGE_KEY]
  return storage().update(next as typeof raw)
}

/**
 * Removes every stored Claude subscription (OAuth) login, keeping API keys.
 * Returns how many logins were removed so the caller can tell the user once.
 * Failures are reported, never thrown: startup must not depend on this.
 */
export function retireClaudeOAuthCredentials(): {
  removed: number
  warning?: string
} {
  if (isBareMode()) return { removed: 0 }
  try {
    const raw = storage().read() || {}
    const providerAccounts = normalizeProviderAccounts(raw.providerAccounts)
    let removed = 0
    for (const account of Object.values(providerAccounts?.claude.accounts ?? {})) {
      if (isUsableClaudeCredential(account.credential)) continue
      removeProviderAccount('claude', account.localAccountId)
      removed += 1
    }
    const after = storage().read() || {}
    const legacy = normalizeClaudeNativeCredentials(
      (after as Record<string, unknown>)[CLAUDE_NATIVE_STORAGE_KEY],
    )
    if (legacy && !isUsableClaudeCredential(legacy)) {
      const next = { ...(after as Record<string, unknown>) }
      delete next[CLAUDE_NATIVE_STORAGE_KEY]
      const result = storage().update(next as typeof after)
      if (!result.success) return { removed, warning: result.warning }
      if (removed === 0) removed = 1
    }
    return { removed }
  } catch (error) {
    return {
      removed: 0,
      warning: error instanceof Error ? error.message : 'secure_storage_read_failed',
    }
  }
}
