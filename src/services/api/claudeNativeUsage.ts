import type { ExtraUsage, RateLimit, Utilization } from './usage.js'

export type ClaudeNativeUsageRow = {
  label: string
  limit: RateLimit
}

type RecordLike = Record<string, unknown>

export type ClaudeNativeScopedUsage = {
  id: string
  modelScope: string
  utilization: number
  windowMinutes?: number
  resetsAt?: string
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === 'object' && value !== null
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function slugifyScope(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function normalizeScopedUsage(value: unknown): ClaudeNativeScopedUsage[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!isRecord(item)) return []
    // Schema real de /api/oauth/usage (limits[]): `percent`,
    // `scope.model.display_name` e `kind`; sem `id` nem `window_seconds`.
    // Schema legado (scoped_limits[]): `id`/`model_scope`/`utilization`.
    // Só o display_name do scope é lido — ids internos do modelo nunca vazam.
    const scopeRecord = isRecord(item.scope) ? item.scope : undefined
    const modelRecord =
      scopeRecord && isRecord(scopeRecord.model) ? scopeRecord.model : undefined
    const displayName =
      asString(modelRecord?.display_name) ?? asString(modelRecord?.displayName)
    const modelScope =
      asString(item.model_scope) ??
      asString(item.modelScope) ??
      asString(item.scope) ??
      displayName
    const legacyId =
      asString(item.id) ?? asString(item.limit_id) ?? asString(item.limitId)
    const utilization =
      asNumber(item.percent) ??
      asNumber(item.utilization) ??
      asNumber(item.used_percentage) ??
      asNumber(item.usedPercent)
    const resolvedScope = modelScope ? slugifyScope(modelScope) : undefined
    if (!resolvedScope || utilization === undefined) return []
    const windowMinutes =
      asNumber(item.window_minutes) ??
      asNumber(item.windowMinutes) ??
      (() => {
        const seconds =
          asNumber(item.window_seconds) ?? asNumber(item.windowSeconds)
        return seconds === undefined ? undefined : Math.round(seconds / 60)
      })() ??
      // O raw limits[] não carrega a janela; weekly_scoped é sempre semanal.
      (item.kind === 'weekly_scoped' ? 10_080 : undefined)
    return [{
      // id estável derivado do display_name quando o raw não o fornece
      // (ex.: claude:weekly-fable no protocolo).
      id: legacyId ?? `weekly-${resolvedScope}`,
      modelScope: resolvedScope,
      utilization,
      windowMinutes,
      resetsAt: asString(item.resets_at) ?? asString(item.resetsAt),
    }]
  })
}

function field(
  record: RecordLike,
  snakeCase: string,
  camelCase: string,
): unknown {
  return snakeCase in record ? record[snakeCase] : record[camelCase]
}

function normalizeRateLimit(value: unknown): RateLimit | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const utilization =
    asNumber(value.utilization) ??
    asNumber(value.used_percentage) ??
    asNumber(value.usedPercent)
  if (utilization === undefined) return undefined
  return {
    utilization,
    resets_at:
      asString(value.resets_at) ?? asString(value.resetsAt) ?? null,
  }
}

function normalizeExtraUsage(value: unknown): ExtraUsage | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const enabled = asBoolean(value.is_enabled) ?? asBoolean(value.isEnabled)
  if (enabled === undefined) return undefined
  return {
    is_enabled: enabled,
    monthly_limit:
      asNumber(value.monthly_limit) ?? asNumber(value.monthlyLimit) ?? null,
    used_credits:
      asNumber(value.used_credits) ?? asNumber(value.usedCredits) ?? null,
    utilization: asNumber(value.utilization) ?? null,
  }
}

export function normalizeClaudeNativeUsagePayload(payload: unknown): Utilization {
  if (!isRecord(payload)) return {}
  const usage: Utilization = {
    five_hour: normalizeRateLimit(field(payload, 'five_hour', 'fiveHour')),
    seven_day: normalizeRateLimit(field(payload, 'seven_day', 'sevenDay')),
    seven_day_oauth_apps: normalizeRateLimit(
      field(payload, 'seven_day_oauth_apps', 'sevenDayOauthApps'),
    ),
    seven_day_opus: normalizeRateLimit(
      field(payload, 'seven_day_opus', 'sevenDayOpus'),
    ),
    seven_day_sonnet: normalizeRateLimit(
      field(payload, 'seven_day_sonnet', 'sevenDaySonnet'),
    ),
    extra_usage: normalizeExtraUsage(field(payload, 'extra_usage', 'extraUsage')),
  }
  const scoped = normalizeScopedUsage(
    field(payload, 'limits', 'limits') ??
      field(payload, 'scoped_limits', 'scopedLimits'),
  )
  if (scoped.length) {
    usage.scoped_limits = scoped
  }
  return usage
}

export function buildClaudeNativeUsageRows(
  usage: Utilization,
): ClaudeNativeUsageRow[] {
  const candidates: Array<[string, RateLimit | null | undefined]> = [
    ['Current session', usage.five_hour],
    ['Current week (all models)', usage.seven_day],
    ['Current week (OAuth apps)', usage.seven_day_oauth_apps],
    ['Current week (Opus)', usage.seven_day_opus],
    ['Current week (Sonnet)', usage.seven_day_sonnet],
  ]
  return candidates.flatMap(([label, limit]) =>
    limit?.utilization === null || limit === null || limit === undefined
      ? []
      : [{ label, limit }],
  )
}

export const CLAUDE_API_KEY_USAGE_UNAVAILABLE =
  'Uso por janela não existe para chave de API da Anthropic; o consumo aparece no Console da Anthropic (console.anthropic.com).'

/**
 * Usage windows (session/weekly limits) belonged to the Claude subscription
 * login, which was retired. An API key has no such windows: its spend is
 * reported by the Anthropic Console, so there is nothing to fetch here.
 */
export async function fetchClaudeNativeUsage(_options?: {
  localAccountId?: string
}): Promise<Utilization> {
  throw new Error(CLAUDE_API_KEY_USAGE_UNAVAILABLE)
}
