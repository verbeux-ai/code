import type { ProviderId } from './types.js'
import type { ProviderAccountSummary } from './store.js'

const loginCommand: Record<ProviderId, string> = {
  codex: '/codex',
  claude: '/claude',
}

const providerLabel: Record<ProviderId, string> = {
  codex: 'Codex',
  claude: 'Claude',
}

export function formatProviderAccountStatus(
  provider: ProviderId,
  accounts: ProviderAccountSummary[],
): string {
  const providerAccounts = accounts.filter(account => account.provider === provider)
  if (providerAccounts.length === 0) {
    return `${providerLabel[provider]} não conectado. Execute ${loginCommand[provider]} login para desbloquear modelos adicionais.`
  }

  const defaultAccount = providerAccounts.find(account => account.isDefault) ?? providerAccounts[0]
  const accountText = `${providerAccounts.length} conta${providerAccounts.length === 1 ? '' : 's'}; padrão: ${defaultAccount.displayLabel}`
  return `${providerLabel[provider]} conectado (${accountText}). Use ${loginCommand[provider]} login para adicionar ou trocar de conta.`
}
