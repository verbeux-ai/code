import {
  getSecureStorage,
  type SecureStorageData,
} from '../secureStorage/index.js'
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

export function readSecureData(): SecureStorageData {
  try {
    return storage().read() ?? {}
  } catch {
    return {}
  }
}

function commitSecureData(data: SecureStorageData): void {
  const result = storage().update(data)
  if (!result.success) {
    throw new Error(result.warning ?? 'secure_storage_write_failed')
  }
}

function prepareMutableState(): {
  data: SecureStorageData
  accounts: ProviderAccountsV1
} {
  const data = readSecureData()
  const migration = migrateProviderAccounts(data)
  const accounts = normalizeProviderAccounts(migration.data.providerAccounts)
    ?? emptyProviderAccounts()
  return {
    data: { ...migration.data, providerAccounts: accounts },
    accounts,
  }
}

function nextDisplayLabel(
  provider: ProviderId,
  collection: ProviderAccountCollection<unknown>,
): string {
  const prefix = provider === 'codex' ? 'Codex' : 'Claude'
  const used = Object.values(collection.accounts)
    .map(account => {
      const match = new RegExp(`^${prefix} (\\d+)$`).exec(account.displayLabel)
      return match ? Number(match[1]) : 0
    })
    .filter(Number.isFinite)
  const next = (used.length ? Math.max(...used) : 0) + 1
  return `${prefix} ${next}`
}

function normalizeCredentialForProvider(
  provider: ProviderId,
  credential: CodexCredentialBlob | ClaudeNativeCredentialBlob,
): CodexCredentialBlob | ClaudeNativeCredentialBlob {
  const normalized = provider === 'codex'
    ? normalizeCodexCredentialBlob(credential)
    : normalizeClaudeNativeCredentials(credential)
  if (!normalized || !normalized.accountId) {
    throw new Error('provider_identity_missing')
  }
  return normalized
}

function mirrorDefaultCredential(
  data: SecureStorageData,
  provider: ProviderId,
  account: ProviderAccountRecord<CodexCredentialBlob | ClaudeNativeCredentialBlob> | undefined,
): SecureStorageData {
  const next = { ...data }
  if (provider === 'codex') {
    if (account) next.codex = account.credential as CodexCredentialBlob
    else delete next.codex
  } else if (account) {
    next.claudeNative = account.credential as ClaudeNativeCredentialBlob
  } else {
    delete next.claudeNative
  }
  return next
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

export function upsertProviderAccount(
  provider: ProviderId,
  credential: CodexCredentialBlob | ClaudeNativeCredentialBlob,
  options?: { reconnectLocalAccountId?: LocalProviderAccountId },
): { localAccountId: LocalProviderAccountId; created: boolean } {
  const normalized = normalizeCredentialForProvider(provider, credential)
  const { data, accounts } = prepareMutableState()
  const collection = {
    ...accounts[provider],
    accounts: { ...accounts[provider].accounts },
  } as ProviderAccountCollection<CodexCredentialBlob | ClaudeNativeCredentialBlob>
  const providerSubjectId = normalized.accountId!
  const existingBySubject = Object.values(collection.accounts).find(
    account => account.providerSubjectId === providerSubjectId,
  )
  const requestedId = options?.reconnectLocalAccountId
  if (requestedId && !collection.accounts[requestedId]) {
    throw new Error('provider_account_not_found')
  }
  if (
    requestedId &&
    collection.accounts[requestedId] &&
    collection.accounts[requestedId].providerSubjectId !== providerSubjectId
  ) {
    throw new Error('provider_identity_mismatch')
  }
  if (
    requestedId &&
    existingBySubject &&
    existingBySubject.localAccountId !== requestedId
  ) {
    throw new Error('provider_identity_mismatch')
  }
  const existing = requestedId
    ? collection.accounts[requestedId]
    : existingBySubject
  const localAccountId = existing?.localAccountId ?? crypto.randomUUID()
  const account: ProviderAccountRecord<
    CodexCredentialBlob | ClaudeNativeCredentialBlob
  > = {
    localAccountId,
    providerSubjectId,
    displayLabel: existing?.displayLabel ?? nextDisplayLabel(provider, collection),
    credential: normalized,
    connectionState: 'connected',
    planId: existing?.planId,
    planDisplayName: existing?.planDisplayName,
    lastValidatedAt: existing?.lastValidatedAt,
  }
  collection.accounts[localAccountId] = account as never
  const nextAccounts = {
    ...accounts,
    [provider]: collection,
  } as ProviderAccountsV1
  if (!collection.defaultAccountId) {
    collection.defaultAccountId = localAccountId
  }
  const defaultAccount = collection.accounts[collection.defaultAccountId]
  commitSecureData(
    mirrorDefaultCredential(
      { ...data, providerAccounts: nextAccounts },
      provider,
      defaultAccount,
    ),
  )
  return { localAccountId, created: !existing }
}

export function reconnectProviderAccount(
  provider: ProviderId,
  localAccountId: LocalProviderAccountId,
  credential: CodexCredentialBlob | ClaudeNativeCredentialBlob,
): { localAccountId: LocalProviderAccountId; created: boolean } {
  return upsertProviderAccount(provider, credential, {
    reconnectLocalAccountId: localAccountId,
  })
}

export function setDefaultProviderAccount(
  provider: ProviderId,
  localAccountId: LocalProviderAccountId,
): void {
  const { data, accounts } = prepareMutableState()
  const collection = {
    ...accounts[provider],
    accounts: { ...accounts[provider].accounts },
  }
  const account = collection.accounts[localAccountId]
  if (!account) throw new Error('provider_account_not_found')
  collection.defaultAccountId = localAccountId
  const nextAccounts = {
    ...accounts,
    [provider]: collection,
  }
  commitSecureData(
    mirrorDefaultCredential(
      { ...data, providerAccounts: nextAccounts },
      provider,
      account,
    ),
  )
}

export function removeProviderAccount(
  provider: ProviderId,
  localAccountId: LocalProviderAccountId,
): void {
  const { data, accounts } = prepareMutableState()
  const collection = {
    ...accounts[provider],
    accounts: { ...accounts[provider].accounts },
  }
  if (!collection.accounts[localAccountId]) {
    throw new Error('provider_account_not_found')
  }
  const wasDefault = collection.defaultAccountId === localAccountId
  delete collection.accounts[localAccountId]
  if (wasDefault) {
    collection.defaultAccountId = Object.keys(collection.accounts).sort()[0]
  }
  const nextAccounts = {
    ...accounts,
    [provider]: collection,
  }
  const defaultAccount = collection.defaultAccountId
    ? collection.accounts[collection.defaultAccountId]
    : undefined
  commitSecureData(
    mirrorDefaultCredential(
      { ...data, providerAccounts: nextAccounts },
      provider,
      defaultAccount,
    ),
  )
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

export type ResolvedProviderAccount = {
  provider: ProviderId
  accountId: LocalProviderAccountId
  record: ProviderAccountRecord<CodexCredentialBlob | ClaudeNativeCredentialBlob>
}

/** Resolve an opaque local ID without allowing the caller to infer provider subjects. */
export function resolveProviderAccountByLocalId(
  localAccountId: LocalProviderAccountId,
  data: ProviderAccountsV1 = readProviderAccounts(),
): ResolvedProviderAccount | undefined {
  const matches = (['codex', 'claude'] as const).flatMap(provider => {
    const record = data[provider].accounts[localAccountId]
    return record ? [{ provider, accountId: localAccountId, record }] : []
  })
  return matches.length === 1 ? matches[0] : undefined
}
