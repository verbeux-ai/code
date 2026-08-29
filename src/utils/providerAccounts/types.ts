import type {
  ClaudeNativeCredentialBlob,
  CodexCredentialBlob,
} from './credentials.js'

export type ProviderId = 'codex' | 'claude'
export type LocalProviderAccountId = string
export type ProviderConnectionState = 'connected' | 'needs_reconnect'

export type ProviderAccountRecord<TCredential> = {
  localAccountId: LocalProviderAccountId
  providerSubjectId: string
  displayLabel: string
  credential: TCredential
  connectionState: ProviderConnectionState
  planId?: string
  planDisplayName?: string
  lastValidatedAt?: string
}

export type ProviderAccountCollection<TCredential> = {
  defaultAccountId?: LocalProviderAccountId
  accounts: Record<LocalProviderAccountId, ProviderAccountRecord<TCredential>>
}

export type ProviderAccountsV1 = {
  schemaVersion: 1
  codex: ProviderAccountCollection<CodexCredentialBlob>
  claude: ProviderAccountCollection<ClaudeNativeCredentialBlob>
}

export type ProviderUsageWindowV1 = {
  id: string
  kind: 'session' | 'weekly' | 'model-scoped-weekly' | 'unknown'
  displayLabel: string
  modelScope?: string
  usedPercent: number
  resetsAt?: string
  /**
   * Optional window duration copied from the provider response (minutes).
   * Additive and backwards-compatible — older CLI builds will omit it
   * and the app falls back to its kind-based presentation.
   */
  windowMinutes?: number
}

export type ProviderUsageSnapshotV1 = {
  schemaVersion: 1
  provider: ProviderId
  accountId: LocalProviderAccountId
  plan?: { id: string; displayName: string }
  windows: ProviderUsageWindowV1[]
  fetchedAt: string
}
