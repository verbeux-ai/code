import axios from 'axios'

import { VERBOO_API_BASE_URL } from '../../constants/oauth.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'

export type SubscriptionResponse = {
  id: string
  groupId: string
  group?: {
    id: string
    name: string
    slug: string
    priceCents: number
    currency: string
    billingInterval: string
    status: string
    models?: string[]
  }
  source?: string
  status: string
  currentPeriodStart?: string
  currentPeriodEnd?: string
  cancelAtPeriodEnd: boolean
}

export async function fetchSubscriptions(
  accessToken: string,
): Promise<SubscriptionResponse[]> {
  try {
    const response = await axios.get<{ data: SubscriptionResponse[] }>(
      `${VERBOO_API_BASE_URL}/api/me/subscriptions`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 10_000,
        validateStatus: () => true,
      },
    )
    if (response.status === 200 && response.data?.data) {
      return response.data.data
    }
    logForDebugging(
      `[Subscriptions] GET /me/subscriptions retornou ${response.status}`,
    )
    return []
  } catch (err) {
    logError(err as Error)
    logForDebugging(
      `[Subscriptions] Erro ao buscar subscriptions: ${(err as Error).message ?? String(err)}`,
    )
    return []
  }
}

export async function fetchPortalUrl(accessToken: string): Promise<string | null> {
  try {
    const response = await axios.get<{ data: { url: string } }>(
      `${VERBOO_API_BASE_URL}/api/me/subscriptions/portal`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 10_000,
        validateStatus: () => true,
      },
    )
    if (response.status === 200 && response.data?.data?.url) {
      return response.data.data.url
    }
    logForDebugging(
      `[Subscriptions] Portal retornou ${response.status}`,
    )
    return null
  } catch (err) {
    logError(err as Error)
    logForDebugging(
      `[Subscriptions] Erro ao buscar portal: ${(err as Error).message ?? String(err)}`,
    )
    return null
  }
}
