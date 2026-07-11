import axios from 'axios'

import { VERBOO_API_BASE_URL } from '../../constants/oauth.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'

export type MarketplaceGroup = {
  id: string
  name: string
  slug: string
  description?: string
  priceCents: number
  currency: string
  billingInterval: 'month' | 'year'
  instances: Array<{
    models: Array<{ modelName: string }>
  }>
  memberCount?: number
  subscriberLimit?: number | null
  trialDays?: number | null
  maxTokensPerSec?: number | null
  paymentProvider: 'stripe' | 'woovi' | 'both'
}

const CACHE_TTL_MS = 2 * 60 * 1000
let cache: { fetchedAt: number; groups: MarketplaceGroup[] } | null = null

export function clearMarketplaceCache(): void {
  cache = null
}

export async function fetchMarketplaceGroups(
  opts: { force?: boolean } = {},
): Promise<MarketplaceGroup[]> {
  if (!opts.force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.groups
  }

  const endpoint = `${VERBOO_API_BASE_URL}/api/marketplace`
  try {
    const response = await axios.get<{ data: MarketplaceGroup[] }>(endpoint, {
      timeout: 10_000,
    })
    const groups = response.data?.data ?? []
    cache = { fetchedAt: Date.now(), groups }
    logForDebugging(
      `[Marketplace] Fetched ${groups.length} groups from ${endpoint}`,
    )
    return groups
  } catch (error) {
    logError(error as Error)
    const msg = `[Marketplace] Erro ao buscar planos: ${(error as Error).message ?? String(error)}`
    logForDebugging(msg)
    process.stderr.write(msg + '\n')
    return cache?.groups ?? []
  }
}
