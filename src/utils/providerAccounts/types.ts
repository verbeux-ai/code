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
