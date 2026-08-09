import { asTrimmedString, parseChatgptAccountId, decodeJwtPayload } from '../../services/api/codexOAuthShared.js'

export type CodexCredentialBlob = {
  apiKey?: string
  accessToken: string
  refreshToken?: string
  idToken?: string
  accountId?: string
  profileId?: string
  lastRefreshAt?: number
  lastRefreshFailureAt?: number
}

export type ClaudeRiskAcceptance = {
  version: number
  acceptedAt: string
  accountId: string
}

export type ClaudeNativeCredentialBlob = {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  scopes: string[]
  accountId: string
  email?: string
  organizationId?: string
  planId?: string
  planDisplayName?: string
  riskAcceptance: ClaudeRiskAcceptance
  lastRefreshAt?: number
  lastRefreshFailureAt?: number
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizeRiskAcceptance(value: unknown): ClaudeRiskAcceptance | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const version = finiteNumber(record.version)
  const acceptedAt = asTrimmedString(record.acceptedAt)
  const accountId = asTrimmedString(record.accountId)
  if (version === undefined || !acceptedAt || !accountId) return undefined
  return { version, acceptedAt, accountId }
}

export function normalizeClaudeNativeCredentials(
  value: unknown,
): ClaudeNativeCredentialBlob | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const accessToken = asTrimmedString(record.accessToken)
  const accountId = asTrimmedString(record.accountId)
  const riskAcceptance = normalizeRiskAcceptance(record.riskAcceptance)
  if (!accessToken || !accountId || !riskAcceptance) return undefined
  if (riskAcceptance.accountId !== accountId) return undefined

  return {
    accessToken,
    refreshToken: asTrimmedString(record.refreshToken),
    expiresAt: finiteNumber(record.expiresAt),
    scopes: Array.isArray(record.scopes)
      ? record.scopes.filter((scope): scope is string => typeof scope === 'string')
      : [],
    accountId,
    email: asTrimmedString(record.email),
    organizationId: asTrimmedString(record.organizationId),
    planId: asTrimmedString(record.planId),
    planDisplayName: asTrimmedString(record.planDisplayName),
    riskAcceptance,
    lastRefreshAt: finiteNumber(record.lastRefreshAt),
    lastRefreshFailureAt: finiteNumber(record.lastRefreshFailureAt),
  }
}

function parseJwtExpiryMs(token: string | undefined): number | undefined {
  if (!token) return undefined
  const payload = decodeJwtPayload(token)
  const exp = payload?.exp
  if (typeof exp === 'number' && Number.isFinite(exp)) return exp * 1000
  return undefined
}

export function normalizeCodexCredentialBlob(
  value: unknown,
): CodexCredentialBlob | undefined {
  if (!value || typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>
  const apiKey = asTrimmedString(record.apiKey)
  const accessToken = asTrimmedString(record.accessToken)
  if (!accessToken) return undefined

  const refreshToken = asTrimmedString(record.refreshToken)
  const idToken = asTrimmedString(record.idToken)
  const accountId =
    asTrimmedString(record.accountId) ??
    parseChatgptAccountId(idToken) ??
    parseChatgptAccountId(accessToken)
  const profileId = asTrimmedString(record.profileId)

  return {
    apiKey,
    accessToken,
    refreshToken,
    idToken,
    accountId,
    profileId,
    lastRefreshAt: finiteNumber(record.lastRefreshAt),
    lastRefreshFailureAt: finiteNumber(record.lastRefreshFailureAt),
  }
}

export function codexTokenExpiryMs(
  credentials: Pick<CodexCredentialBlob, 'accessToken' | 'idToken'>,
): number | undefined {
  return (
    parseJwtExpiryMs(credentials.accessToken) ??
    parseJwtExpiryMs(credentials.idToken)
  )
}
