import axios from 'axios'
import { z } from 'zod'
import { VERBOO_API_BASE_URL } from '../../constants/oauth.js'
import { getClaudeAIOAuthTokensAsync, getOauthAccountInfo } from '../../utils/auth.js'
import { withOAuth401Retry } from '../../utils/http.js'
import { parseApiEnvelope } from './verbooApiError.js'
import { readWithRetry, retryableReadStatus, retryAfterMilliseconds } from './readRetry.js'

export const usageWindowsSchema = z.array(z.object({
  groupId: z.guid(), groupName: z.string(), limited: z.boolean(), blocked: z.boolean(), accountingPending: z.boolean(), availableAt: z.string().nullable(),
  windows: z.array(z.object({ id: z.guid(), durationSeconds: z.number().int().positive(), usedPercent: z.number().min(0).max(100), resetsAt: z.string().nullable() })),
}))
export type UsageWindowsStatus = z.infer<typeof usageWindowsSchema>
export async function fetchUsageWindows(signal?: AbortSignal): Promise<UsageWindowsStatus> {
  const owner = getOauthAccountInfo()?.accountUuid
  return readWithRetry(attemptSignal => withOAuth401Retry(async () => {
    if (getOauthAccountInfo()?.accountUuid !== owner) throw new Error('A conta mudou durante a consulta.')
    const tokens = await getClaudeAIOAuthTokensAsync()
    if (!tokens?.accessToken) throw new Error('Execute /login para consultar o uso.')
    const response = await axios.get(`${VERBOO_API_BASE_URL}/api/me/usage-windows`, { headers: { Authorization: `Bearer ${tokens.accessToken}` }, timeout: 10_000, signal: attemptSignal })
    if (getOauthAccountInfo()?.accountUuid !== owner) throw new Error('A conta mudou durante a consulta.')
    return parseApiEnvelope(usageWindowsSchema, response.data, 'janelas de uso')
  }), error => {
    if (axios.isAxiosError(error)) return { retry: error.code !== 'ERR_CANCELED' && (error.response ? retryableReadStatus.has(error.response.status) : true), delayMs: retryAfterMilliseconds(error.response?.headers?.['retry-after']) }
    return { retry: error instanceof Error && error.name === 'TimeoutError' }
  }, signal)
}
