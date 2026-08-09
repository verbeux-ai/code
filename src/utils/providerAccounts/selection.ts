import {
  resolveProviderAccountByLocalId,
  type ResolvedProviderAccount,
} from './store.js'
import type { LocalProviderAccountId, ProviderId } from './types.js'

export type ProviderAccountSelection = {
  provider: ProviderId
  accountId: LocalProviderAccountId
}

let processSelection: ProviderAccountSelection | undefined

export function resolveProviderAccountSelection(
  provider: ProviderId,
  accountId: LocalProviderAccountId,
): ResolvedProviderAccount & {
  credential: ResolvedProviderAccount['record']['credential']
} {
  const resolved = resolveProviderAccountByLocalId(accountId)
  if (!resolved) throw new Error('provider_account_not_found')
  if (resolved.provider !== provider) {
    throw new Error('provider_account_mismatch')
  }
  return { ...resolved, credential: resolved.record.credential }
}

export function initializeProviderAccountSelection(
  accountId: LocalProviderAccountId,
): ProviderAccountSelection {
  if (processSelection) {
    throw new Error('provider_account_selection_already_initialized')
  }
  const resolved = resolveProviderAccountByLocalId(accountId)
  if (!resolved) throw new Error('provider_account_not_found')
  processSelection = {
    provider: resolved.provider,
    accountId: resolved.accountId,
  }
  return processSelection
}

export function getSelectedProviderAccount():
  | ProviderAccountSelection
  | undefined {
  return processSelection
}
