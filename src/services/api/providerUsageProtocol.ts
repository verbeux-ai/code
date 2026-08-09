import {
  fetchClaudeNativeUsage,
  type ClaudeNativeScopedUsage,
} from './claudeNativeUsage.js'
import {
  fetchCodexUsage,
  normalizeCodexUsagePayload,
  type CodexUsageData,
  type CodexUsageSnapshot,
  type CodexUsageWindow,
} from './codexUsage.js'
import { resolveProviderAccount } from '../../utils/providerAccounts/store.js'
import type {
  ClaudeNativeCredentialBlob,
  CodexCredentialBlob,
} from '../../utils/providerAccounts/credentials.js'
import type {
  LocalProviderAccountId,
  ProviderAccountRecord,
  ProviderId,
  ProviderUsageSnapshotV1,
  ProviderUsageWindowV1,
} from '../../utils/providerAccounts/types.js'
import type { Utilization } from './usage.js'
import { normalizeClaudeNativeUsagePayload } from './claudeNativeUsage.js'

type PlanHint = { id: string; displayName: string }
type ProviderAccountCredential = CodexCredentialBlob | ClaudeNativeCredentialBlob

function asPlan(id: unknown, displayName?: unknown): PlanHint | undefined {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(id.trim())) {
    return undefined
  }
  const normalizedId = id.trim().toLowerCase()
  const label =
    typeof displayName === 'string' && displayName.trim()
      ? displayName.trim()
      : normalizedId
          .split(/[_-]+/)
          .filter(Boolean)
          .map(part => `${part[0]!.toUpperCase()}${part.slice(1).toLowerCase()}`)
          .join(' ')
  return { id: normalizedId, displayName: label }
}

function percent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : undefined
}

function weeklyWindow(
  snapshot: CodexUsageSnapshot,
): { source: 'primary' | 'secondary'; window: CodexUsageWindow } | undefined {
  if (snapshot.secondary?.windowMinutes === 10_080) {
    return { source: 'secondary', window: snapshot.secondary }
  }
  if (snapshot.primary?.windowMinutes === 10_080) {
    return { source: 'primary', window: snapshot.primary }
  }
  return undefined
}

function scopeLabel(value: string): string {
  return value
    .split(/[_:-]+/)
    .filter(Boolean)
    .map(part => `${part[0]!.toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(' ')
}

function codexUsageData(payload: unknown): CodexUsageData {
  if (
    payload &&
    typeof payload === 'object' &&
    Array.isArray((payload as Record<string, unknown>).snapshots)
  ) {
    return payload as CodexUsageData
  }
  return normalizeCodexUsagePayload(payload)
}

export function normalizeCodexProviderUsage(
  accountId: LocalProviderAccountId,
  payload: unknown,
): ProviderUsageSnapshotV1 {
  const usage = codexUsageData(payload)
  const base = usage.snapshots.find(snapshot => {
    const name = snapshot.limitName.trim().toLowerCase()
    return name === 'codex' || name === 'base'
  })
  const windows: ProviderUsageWindowV1[] = []
  const baseWeekly = base ? weeklyWindow(base) : undefined
  if (baseWeekly) {
    const usedPercent = percent(baseWeekly.window.usedPercent)
    if (usedPercent !== undefined) {
      windows.push({
        id: `codex:${baseWeekly.source}`,
        kind: 'weekly',
        displayLabel: 'Weekly',
        usedPercent,
        resetsAt: baseWeekly.window.resetsAt,
      })
    }
  }

  for (const snapshot of usage.snapshots) {
    const name = snapshot.limitName.trim().toLowerCase()
    if (!name || name === 'codex' || name === 'base' || name === 'code review') {
      continue
    }
    const scoped = weeklyWindow(snapshot)
    if (!scoped) continue
    const usedPercent = percent(scoped.window.usedPercent)
    if (usedPercent === undefined) continue
    windows.push({
      id: `codex:${name.replace(/[^a-z0-9_-]+/gi, '-')}`,
      kind: 'model-scoped-weekly',
      displayLabel: `${scopeLabel(snapshot.limitName)} Weekly`,
      modelScope: name,
      usedPercent,
      resetsAt: scoped.window.resetsAt,
    })
  }

  return {
    schemaVersion: 1,
    provider: 'codex',
    accountId,
    plan: asPlan(usage.planType),
    windows,
    fetchedAt: new Date().toISOString(),
  }
}

function claudeRateWindow(
  id: string,
  kind: ProviderUsageWindowV1['kind'],
  displayLabel: string,
  value: { utilization: number | null; resets_at: string | null } | null | undefined,
): ProviderUsageWindowV1 | undefined {
  const usedPercent = percent(value?.utilization)
  if (usedPercent === undefined) return undefined
  return {
    id,
    kind,
    displayLabel,
    usedPercent,
    resetsAt: value?.resets_at ?? undefined,
  }
}

function claudeUsageData(payload: unknown): Utilization {
  if (
    payload &&
    typeof payload === 'object' &&
    ('scoped_limits' in payload ||
      (('five_hour' in payload || 'seven_day' in payload) &&
        !('limits' in payload)))
  ) {
    return payload as Utilization
  }
  return normalizeClaudeNativeUsagePayload(payload)
}

function scopedClaudeWindows(
  values: ClaudeNativeScopedUsage[] | undefined,
): ProviderUsageWindowV1[] {
  if (!values) return []
  return values.flatMap(value => {
    if (value.windowMinutes !== 10_080) return []
    const usedPercent = percent(value.utilization)
    if (usedPercent === undefined) return []
    const scope = value.modelScope.trim()
    if (!scope) return []
    return [
      {
        id: `claude:${value.id}`,
        kind: 'model-scoped-weekly' as const,
        displayLabel: `${scopeLabel(scope)} Weekly`,
        modelScope: scope,
        usedPercent,
        resetsAt: value.resetsAt,
      },
    ]
  })
}

export function normalizeClaudeProviderUsage(
  accountId: LocalProviderAccountId,
  plan: PlanHint | undefined,
  payload: unknown,
): ProviderUsageSnapshotV1 {
  const usage = claudeUsageData(payload)
  const windows = [
    claudeRateWindow('claude:five-hour', 'session', '5 hours', usage.five_hour),
    claudeRateWindow('claude:weekly', 'weekly', 'Weekly', usage.seven_day),
    ...scopedClaudeWindows(usage.scoped_limits),
  ].filter((window): window is ProviderUsageWindowV1 => window !== undefined)
  return {
    schemaVersion: 1,
    provider: 'claude',
    accountId,
    plan,
    windows,
    fetchedAt: new Date().toISOString(),
  }
}

function accountPlan(
  account: ProviderAccountRecord<ProviderAccountCredential>,
): PlanHint | undefined {
  const credential = account.credential
  return asPlan(
    account.planId ?? ('planId' in credential ? credential.planId : undefined),
    account.planDisplayName ??
      ('planDisplayName' in credential ? credential.planDisplayName : undefined),
  )
}

function usageError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

function sanitizeUsageError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  if (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    (error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'TimeoutError'))
  ) {
    return usageError('provider_usage_timeout', 'O provedor demorou para responder.')
  }
  if (
    lower.includes('auth') ||
    lower.includes('login') ||
    lower.includes('401') ||
    lower.includes('sessão')
  ) {
    return usageError('provider_auth_required', 'A conta precisa ser conectada novamente.')
  }
  return usageError(
    'provider_usage_unavailable',
    'O provedor não informou a cota neste momento.',
  )
}

export async function fetchProviderUsage(
  provider: ProviderId,
  accountId: LocalProviderAccountId,
): Promise<ProviderUsageSnapshotV1> {
  const account = resolveProviderAccount(provider, accountId)
  if (!account) throw usageError('provider_account_not_found', 'Conta não encontrada.')
  try {
    if (provider === 'codex') {
      return normalizeCodexProviderUsage(
        accountId,
        await fetchCodexUsage({ localAccountId: accountId }),
      )
    }
    return normalizeClaudeProviderUsage(
      accountId,
      accountPlan(account),
      await fetchClaudeNativeUsage({ localAccountId: accountId }),
    )
  } catch (error) {
    if (error instanceof Error && 'code' in error) throw error
    throw sanitizeUsageError(error)
  }
}
