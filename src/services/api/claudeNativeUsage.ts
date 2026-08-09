import {
  hasCurrentClaudeRiskAcceptance,
  readClaudeNativeCredentialsAsync,
  refreshClaudeNativeAccessTokenIfNeeded,
  type ClaudeNativeCredentialBlob,
} from '../../utils/claudeNativeCredentials.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { logForDebugging } from '../../utils/debug.js'
import { getVerbooCodeUserAgent } from '../../utils/userAgent.js'
import type { ExtraUsage, RateLimit, Utilization } from './usage.js'
import {
  CLAUDE_NATIVE_API_BASE_URL,
  CLAUDE_NATIVE_OAUTH_BETA,
} from './claudeNativeConfig.js'

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

function normalizeScopedUsage(value: unknown): ClaudeNativeScopedUsage[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!isRecord(item)) return []
    const id = asString(item.id) ?? asString(item.limit_id) ?? asString(item.limitId)
    const modelScope =
      asString(item.model_scope) ??
      asString(item.modelScope) ??
      asString(item.scope)
    const utilization =
      asNumber(item.utilization) ??
      asNumber(item.used_percentage) ??
      asNumber(item.usedPercent)
    if (!id || !modelScope || utilization === undefined) return []
    const windowMinutes =
      asNumber(item.window_minutes) ??
      asNumber(item.windowMinutes) ??
      (() => {
        const seconds =
          asNumber(item.window_seconds) ?? asNumber(item.windowSeconds)
        return seconds === undefined ? undefined : Math.round(seconds / 60)
      })()
    return [{
      id,
      modelScope,
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

export function getClaudeNativeUsageUrl(
  baseUrl = CLAUDE_NATIVE_API_BASE_URL,
): string {
  return new URL('/api/oauth/usage', baseUrl).toString()
}

export function buildClaudeNativeUsageHeaders(
  accessToken: string,
): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'anthropic-beta': CLAUDE_NATIVE_OAUTH_BETA,
    'User-Agent': getVerbooCodeUserAgent(),
  }
}

async function requestClaudeNativeUsage(
  credentials: ClaudeNativeCredentialBlob,
): Promise<{ status: number; body: string; payload?: unknown }> {
  const { signal, cleanup } = createCombinedAbortSignal(undefined, {
    timeoutMs: 5_000,
  })
  try {
    const response = await fetch(getClaudeNativeUsageUrl(), {
      method: 'GET',
      headers: buildClaudeNativeUsageHeaders(credentials.accessToken),
      signal,
    })
    const body = await response.text()
    let payload: unknown
    if (body.trim()) {
      try {
        payload = JSON.parse(body)
      } catch {
        payload = undefined
      }
    }
    return { status: response.status, body, payload }
  } finally {
    cleanup()
  }
}

function usageError(status: number, body: string): Error {
  const detail = body.trim().slice(0, 500)
  return new Error(
    detail
      ? `Claude usage error ${status}: ${detail}`
      : `Claude usage error ${status}.`,
  )
}

export async function fetchClaudeNativeUsage(options?: {
  localAccountId?: string
}): Promise<Utilization> {
  const refreshResult = await refreshClaudeNativeAccessTokenIfNeeded({
    localAccountId: options?.localAccountId,
  }).catch(
    async error => {
      logForDebugging(
        `[claude] access token refresh failed before usage fetch: ${error instanceof Error ? error.message : String(error)}`,
        { level: 'warn' },
      )
      return {
        refreshed: false,
        credentials: await readClaudeNativeCredentialsAsync(options?.localAccountId),
      }
    },
  )
  let credentials =
    refreshResult.credentials ??
    (await readClaudeNativeCredentialsAsync(options?.localAccountId))
  if (!credentials || !hasCurrentClaudeRiskAcceptance(credentials)) {
    throw new Error('Claude auth is required. Execute /claude login.')
  }

  let response = await requestClaudeNativeUsage(credentials)
  if (response.status === 401) {
    const retried = await refreshClaudeNativeAccessTokenIfNeeded({
      force: true,
      localAccountId: options?.localAccountId,
    })
    credentials =
      retried.credentials ??
      (await readClaudeNativeCredentialsAsync(options?.localAccountId))
    if (!credentials || !hasCurrentClaudeRiskAcceptance(credentials)) {
      throw usageError(response.status, response.body)
    }
    response = await requestClaudeNativeUsage(credentials)
  }
  if (response.status < 200 || response.status >= 300) {
    throw usageError(response.status, response.body)
  }
  return normalizeClaudeNativeUsagePayload(response.payload)
}
