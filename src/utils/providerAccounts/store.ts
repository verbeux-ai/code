import { getSecureStorage, type SecureStorageData } from '../secureStorage/index.js'
import {
  normalizeClaudeNativeCredentials,
  normalizeCodexCredentialBlob,
  type ClaudeNativeCredentialBlob,
  type CodexCredentialBlob,
} from './credentials.js'
import type {
  LocalProviderAccountId,
  ProviderAccountCollection,
  ProviderAccountRecord,
  ProviderAccountsV1,
  ProviderConnectionState,
  ProviderId,
} from './types.js'

export type ProviderAccountSummary = {
  provider: ProviderId
  accountId: LocalProviderAccountId
  displayLabel: string
  planId?: string
  planDisplayName?: string
  isDefault: boolean
  connectionState: ProviderConnectionState
  lastValidatedAt?: string
}

const EMPTY_PROVIDER_ACCOUNTS: ProviderAccountsV1 = {
  schemaVersion: 1,
  codex: { accounts: {} },
  claude: { accounts: {} },
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isProviderConnectionState(
  value: unknown,
): value is ProviderConnectionState {
  return value === 'connected' || value === 'needs_reconnect'
}

function cloneProviderAccounts(data: ProviderAccountsV1): ProviderAccountsV1 {
  return {
    schemaVersion: 1,
    codex: {
      defaultAccountId: data.codex.defaultAccountId,
      accounts: { ...data.codex.accounts },
    },
    claude: {
      defaultAccountId: data.claude.defaultAccountId,
      accounts: { ...data.claude.accounts },
    },
  }
}

export function emptyProviderAccounts(): ProviderAccountsV1 {
  return cloneProviderAccounts(EMPTY_PROVIDER_ACCOUNTS)
}

function normalizeCollection<TCredential>(
  provider: ProviderId,
  value: unknown,
  normalizeCredential: (value: unknown) => TCredential | undefined,
  getSubject: (credential: TCredential) => string | undefined,
): ProviderAccountCollection<TCredential> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (!record.accounts || typeof record.accounts !== 'object') return undefined

  const accounts: Record<LocalProviderAccountId, ProviderAccountRecord<TCredential>> = {}
  for (const [key, raw] of Object.entries(
    record.accounts as Record<string, unknown>,
  )) {
    if (!raw || typeof raw !== 'object') return undefined
    const item = raw as Record<string, unknown>
    const localAccountId = nonEmptyString(item.localAccountId)
    const providerSubjectId = nonEmptyString(item.providerSubjectId)
    const displayLabel = nonEmptyString(item.displayLabel)
    const credential = normalizeCredential(item.credential)
    const connectionState = item.connectionState

    if (
      localAccountId !== key ||
      !providerSubjectId ||
      !displayLabel ||
      !credential ||
      !isProviderConnectionState(connectionState) ||
      getSubject(credential) !== providerSubjectId
    ) {
      return undefined
    }

    const planId = nonEmptyString(item.planId)
    const planDisplayName = nonEmptyString(item.planDisplayName)
    const lastValidatedAt = nonEmptyString(item.lastValidatedAt)
    accounts[key] = {
      localAccountId,
      providerSubjectId,
      displayLabel,
      credential,
      connectionState,
      planId,
      planDisplayName,
      lastValidatedAt,
    }
  }

  const defaultAccountId = nonEmptyString(record.defaultAccountId)
  if (defaultAccountId && !accounts[defaultAccountId]) return undefined

  return {
    defaultAccountId,
    accounts,
  }
}

export function normalizeProviderAccounts(
  value: unknown,
): ProviderAccountsV1 | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1) return undefined

  const codex = normalizeCollection(
    'codex',
    record.codex,
    normalizeCodexCredentialBlob,
    credential => credential.accountId,
  )
  const claude = normalizeCollection(
    'claude',
    record.claude,
    normalizeClaudeNativeCredentials,
    credential => credential.accountId,
  )
  if (!codex || !claude) return undefined

  return {
    schemaVersion: 1,
    codex,
    claude,
  }
}

function addMigratedCodex(
  target: ProviderAccountsV1,
  localAccountId: LocalProviderAccountId,
  credential: CodexCredentialBlob,
): boolean {
  if (!credential.accountId) return false
  target.codex.accounts[localAccountId] = {
    localAccountId,
    providerSubjectId: credential.accountId,
    displayLabel: 'Codex 1',
    credential,
    connectionState: 'connected',
  }
  target.codex.defaultAccountId = localAccountId
  return true
}

function addMigratedClaude(
  target: ProviderAccountsV1,
  localAccountId: LocalProviderAccountId,
  credential: ClaudeNativeCredentialBlob,
): boolean {
  target.claude.accounts[localAccountId] = {
    localAccountId,
    providerSubjectId: credential.accountId,
    displayLabel: 'Claude 1',
    credential,
    connectionState: 'connected',
  }
  target.claude.defaultAccountId = localAccountId
  return true
}

export function migrateProviderAccounts(
  data: SecureStorageData,
  makeId: () => LocalProviderAccountId = () => crypto.randomUUID(),
): { data: SecureStorageData; mode: 'v1' | 'legacy' } {
  const existing = normalizeProviderAccounts(data.providerAccounts)
  if (existing) return { data: { ...data, providerAccounts: existing }, mode: 'v1' }

  const next = emptyProviderAccounts()
  const codex = normalizeCodexCredentialBlob(data.codex)
  const claude = normalizeClaudeNativeCredentials(data.claudeNative)
  const migratedCodex = codex ? addMigratedCodex(next, makeId(), codex) : false
  const migratedClaude = claude
    ? addMigratedClaude(next, makeId(), claude)
    : false

  if (!migratedCodex && !migratedClaude) return { data, mode: 'legacy' }

  return {
    data: { ...data, providerAccounts: next },
    mode: 'v1',
  }
}

function storage() {
  return getSecureStorage({ allowPlainTextFallback: false })
}

export function readProviderAccounts(): ProviderAccountsV1 {
  let data: SecureStorageData | null = null
  try {
    data = storage().read()
  } catch {
    return emptyProviderAccounts()
  }

  const migration = migrateProviderAccounts(data ?? {})
  const normalized = normalizeProviderAccounts(migration.data.providerAccounts)
  if (!normalized) return emptyProviderAccounts()

  if (!data?.providerAccounts && migration.mode === 'v1') {
    try {
      storage().update(migration.data)
    } catch {
      // The scalar record remains authoritative until the next successful write.
    }
  }

  return normalized
}

export async function readProviderAccountsAsync(): Promise<ProviderAccountsV1> {
  let data: SecureStorageData | null = null
  try {
    data = await storage().readAsync()
  } catch {
    return emptyProviderAccounts()
  }

  const migration = migrateProviderAccounts(data ?? {})
  const normalized = normalizeProviderAccounts(migration.data.providerAccounts)
  if (!normalized) return emptyProviderAccounts()

  if (!data?.providerAccounts && migration.mode === 'v1') {
    try {
      storage().update(migration.data)
    } catch {
      // Keep the in-memory migrated view; the scalar mirror is still intact.
    }
  }

  return normalized
}

export function listProviderAccountSummaries(
  data: ProviderAccountsV1 = readProviderAccounts(),
): ProviderAccountSummary[] {
  const summaries: ProviderAccountSummary[] = []
  for (const provider of ['codex', 'claude'] as const) {
    const collection = data[provider]
    for (const account of Object.values(collection.accounts)) {
      summaries.push({
        provider,
        accountId: account.localAccountId,
        displayLabel: account.displayLabel,
        planId: account.planId,
        planDisplayName: account.planDisplayName,
        isDefault: collection.defaultAccountId === account.localAccountId,
        connectionState: account.connectionState,
        lastValidatedAt: account.lastValidatedAt,
      })
    }
  }
  return summaries
}

export function resolveProviderAccount(
  provider: ProviderId,
  localAccountId?: LocalProviderAccountId,
  data: ProviderAccountsV1 = readProviderAccounts(),
): ProviderAccountRecord<CodexCredentialBlob | ClaudeNativeCredentialBlob> | undefined {
  const collection = data[provider]
  const id = localAccountId ?? collection.defaultAccountId
  return id ? collection.accounts[id] : undefined
}

