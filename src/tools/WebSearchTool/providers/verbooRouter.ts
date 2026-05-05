import type { SearchInput, SearchProvider, ProviderOutput } from './types.js'
import { applyDomainFilters, safeHostname } from './types.js'
import { VERBOO_ROUTER_URL } from '../../../constants/oauth.js'
import { getClaudeAIOAuthTokens } from '../../../utils/auth.js'

export const verbooRouterProvider: SearchProvider = {
  name: 'verboo-router',

  isConfigured() {
    return getClaudeAIOAuthTokens() !== null
  },

  async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
    const start = performance.now()
    const tokens = getClaudeAIOAuthTokens()
    if (!tokens?.accessToken) throw new Error('verboo-router: unauthenticated')

    const res = await fetch(`${VERBOO_ROUTER_URL}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.accessToken}`,
      },
      body: JSON.stringify({
        query: input.query,
        allowed_domains: input.allowed_domains,
        blocked_domains: input.blocked_domains,
      }),
      signal,
    })

    if (!res.ok) {
      throw new Error(`verboo-router search error ${res.status}: ${await res.text().catch(() => '')}`)
    }

    const data = (await res.json()) as { results?: unknown[] }
    const hits = (data.results ?? []).map((r: any) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      description: r.content,
      source: safeHostname(r.url),
    }))

    return {
      hits: applyDomainFilters(hits, input),
      providerName: 'verboo-router',
      durationSeconds: (performance.now() - start) / 1000,
    }
  },
}
