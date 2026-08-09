import { assertCLIEntitlement } from '../../services/oauth/cliEntitlement.js'
import {
  listProviderAccountSummaries,
  readProviderAccounts,
  removeProviderAccount,
  resolveProviderAccount,
  setDefaultProviderAccount,
} from '../../utils/providerAccounts/store.js'
import type {
  LocalProviderAccountId,
  ProviderId,
} from '../../utils/providerAccounts/types.js'

export type ProviderCommandEnvelope<T> =
  | { schemaVersion: 1; ok: true; data: T }
  | { schemaVersion: 1; ok: false; error: { code: string; message: string } }

export type ProviderAccountsCommandDependencies = {
  ensureAuthenticated?: () => Promise<unknown>
}

const PROTOCOLS = ['provider_accounts_v1', 'provider_usage_v1'] as const

function success<T>(data: T): ProviderCommandEnvelope<T> {
  return { schemaVersion: 1, ok: true, data }
}

function failure(code: string, message: string): ProviderCommandEnvelope<never> {
  return { schemaVersion: 1, ok: false, error: { code, message } }
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  const value = index === -1 ? undefined : argv[index + 1]
  return value && !value.startsWith('-') ? value : undefined
}

function providerValue(value: string | undefined): ProviderId | undefined {
  return value === 'codex' || value === 'claude' ? value : undefined
}

function accountValue(argv: string[], provider: ProviderId): LocalProviderAccountId | undefined {
  const explicit = optionValue(argv, '--account')
  if (explicit) return explicit
  return readProviderAccounts()[provider].defaultAccountId
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code
  }
  if (error instanceof Error && error.message.includes('Sessão')) {
    return 'verboo_auth_required'
  }
  return 'provider_command_failed'
}

export async function runProviderAccountsCommand(
  argv: string[],
  dependencies: ProviderAccountsCommandDependencies = {},
): Promise<ProviderCommandEnvelope<unknown>> {
  try {
    await (dependencies.ensureAuthenticated ?? (async () => {
      await assertCLIEntitlement()
    }))()
  } catch {
    return failure(
      'verboo_auth_required',
      'Faça login no Verboo antes de consultar as contas dos provedores.',
    )
  }

  try {
    const command = argv[0] ?? 'capabilities'
    if (command === 'capabilities') {
      return success({
        protocols: [...PROTOCOLS],
        loginTransport: 'pty-slash-v1',
      })
    }

    if (command === 'list') {
      return success({
        protocols: [...PROTOCOLS],
        accounts: listProviderAccountSummaries().map(account => ({
          schemaVersion: 1,
          provider: account.provider,
          accountId: account.accountId,
          displayLabel: account.displayLabel,
          planId: account.planId,
          planDisplayName: account.planDisplayName,
          isDefault: account.isDefault,
          connectionState: account.connectionState,
          lastValidatedAt: account.lastValidatedAt,
        })),
      })
    }

    if (command === 'usage') {
      const provider = providerValue(optionValue(argv, '--provider'))
      if (!provider) {
        return failure(
          'provider_argument_required',
          'Informe --provider codex ou --provider claude.',
        )
      }
      const accountId = accountValue(argv, provider)
      if (!accountId || !resolveProviderAccount(provider, accountId)) {
        return failure('provider_account_not_found', 'Conta não encontrada.')
      }
      const { fetchProviderUsage } = await import(
        '../../services/api/providerUsageProtocol.js'
      )
      return success(await fetchProviderUsage(provider, accountId))
    }

    if (command === 'set-default' || command === 'remove') {
      const provider = providerValue(optionValue(argv, '--provider'))
      const accountId = optionValue(argv, '--account')
      if (!provider || !accountId) {
        return failure(
          'provider_argument_required',
          'Informe --provider e --account.',
        )
      }
      if (!resolveProviderAccount(provider, accountId)) {
        return failure('provider_account_not_found', 'Conta não encontrada.')
      }
      if (command === 'set-default') {
        setDefaultProviderAccount(provider, accountId)
      } else {
        removeProviderAccount(provider, accountId)
      }
      return success({ changed: true })
    }

    return failure('provider_command_unknown', 'Comando provider-accounts desconhecido.')
  } catch (error) {
    const code = errorCode(error)
    const message =
      code === 'provider_account_not_found'
        ? 'Conta não encontrada.'
        : code === 'provider_usage_timeout'
          ? 'O provedor demorou para responder.'
          : code === 'provider_auth_required'
            ? 'A conta precisa ser conectada novamente.'
            : 'Não foi possível concluir a operação do provedor.'
    return failure(code, message)
  }
}
