import type { SearchInput, SearchProvider, ProviderOutput } from './types.js'
import {
  applyDomainFilters,
  safeHostname,
  SearchUnavailableError,
} from './types.js'
import { VERBOO_ROUTER_URL } from '../../../constants/oauth.js'
import { getCachedVerbooWebSearchCapability } from '../../../services/api/verbooModels.js'
import {
  parsePaymentPastDue,
  paymentPastDueError,
} from '../../../services/oauth/paymentPastDue.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  didOAuthRefreshRecover,
  getClaudeAIOAuthTokens,
  handleOAuth401ErrorWithOutcome,
} from '../../../utils/auth.js'
import { createCombinedAbortSignal } from '../../../utils/combinedAbortSignal.js'
import { logForDebugging } from '../../../utils/debug.js'

/** Upper bound for one router search, including the single 401 retry. */
export const VERBOO_SEARCH_TIMEOUT_MS = 30_000
let searchTimeoutMs = VERBOO_SEARCH_TIMEOUT_MS

export const __test = {
  setSearchTimeoutMs(ms: number = VERBOO_SEARCH_TIMEOUT_MS): void {
    searchTimeoutMs = ms
  },
}

const TEMPORARILY_UNAVAILABLE_MESSAGE =
  'Verboo web search is temporarily unavailable.'
// VERBOO-BRAND
const PLAN_REQUIRED_MESSAGE = 'Web search requires an active Verboo plan.'
// VERBOO-BRAND
const AUTH_REQUIRED_MESSAGE =
  'Your Verboo session was not accepted for web search. Run /login to sign in again.'

type RouterErrorBody = { code?: string; message?: string }

function parseRouterErrorBody(text: string): RouterErrorBody {
  try {
    const parsed = JSON.parse(text) as {
      error?: { code?: unknown; message?: unknown }
    }
    const error = parsed?.error
    return {
      code: typeof error?.code === 'string' ? error.code : undefined,
      message: typeof error?.message === 'string' ? error.message : undefined,
    }
  } catch {
    return {}
  }
}

/**
 * Maps a failed router response to what the user/model should see. Returns
 * null for failures that are real errors (e.g. a rejected request), which
 * the caller surfaces as a tool error.
 */
export function classifyRouterSearchFailure(
  status: number,
  body: RouterErrorBody,
): SearchUnavailableError | null {
  const { code } = body
  const opts = { code, status }
  if (status === 401) {
    return new SearchUnavailableError('auth_required', AUTH_REQUIRED_MESSAGE, opts)
  }
  if (status === 403 && code === 'search_access_required') {
    return new SearchUnavailableError('plan_required', PLAN_REQUIRED_MESSAGE, opts)
  }
  if (
    code === 'search_disabled' ||
    code?.startsWith('search_provider_') ||
    status === 408 ||
    status === 429 ||
    status >= 500
  ) {
    return new SearchUnavailableError(
      'temporarily_unavailable',
      TEMPORARILY_UNAVAILABLE_MESSAGE,
      opts,
    )
  }
  return null
}

/**
 * Turns a failed router response into the error search() throws: a
 * past-due subscription gets the billing link, outages and missing plans
 * become SearchUnavailableError, and anything else keeps the raw status and
 * body.
 */
export async function verbooRouterSearchError(res: Response): Promise<Error> {
  const body = await res.text().catch(() => '')
  const pastDue = parsePaymentPastDue(res.status, body)
  if (pastDue) return paymentPastDueError(pastDue.serverMessage)
  const unavailable = classifyRouterSearchFailure(
    res.status,
    parseRouterErrorBody(body),
  )
  if (unavailable) return unavailable
  return new Error(`verboo-router search error ${res.status}: ${body}`)
}

function unreachable(requestSignal: AbortSignal): SearchUnavailableError {
  return new SearchUnavailableError(
    'temporarily_unavailable',
    TEMPORARILY_UNAVAILABLE_MESSAGE,
    { code: requestSignal.aborted ? 'search_timeout' : 'search_network_error' },
  )
}

async function postSearch(
  accessToken: string,
  input: SearchInput,
  requestSignal: AbortSignal,
  callerSignal: AbortSignal | undefined,
): Promise<Response> {
  try {
    return await fetch(`${VERBOO_ROUTER_URL}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        query: input.query,
        allowed_domains: input.allowed_domains,
        blocked_domains: input.blocked_domains,
      }),
      signal: requestSignal,
    })
  } catch (error) {
    // A user interrupt must stay an abort so the tool call is cancelled.
    if (callerSignal?.aborted) throw error
    // Our timeout or a network failure: the backend is unreachable right now,
    // which the user should see as "unavailable", not as a crash.
    logForDebugging(`[web-search] verboo-router unreachable: ${error}`)
    throw unreachable(requestSignal)
  }
}

export const verbooRouterProvider: SearchProvider = {
  name: 'verboo-router',

  isConfigured() {
    return getClaudeAIOAuthTokens() !== null
  },

  async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
    const start = performance.now()

    // The router advertises search availability on /models. Trust a fresh
    // "disabled" so we don't spend a round-trip on a known 503.
    if (getCachedVerbooWebSearchCapability() === false) {
      throw new SearchUnavailableError(
        'temporarily_unavailable',
        TEMPORARILY_UNAVAILABLE_MESSAGE,
        { code: 'search_disabled' },
      )
    }

    // Same proactive refresh the model client runs before each request, so an
    // expired access token doesn't turn into a failed search.
    try {
      await checkAndRefreshOAuthTokenIfNeeded()
    } catch (error) {
      logForDebugging(`[web-search] verboo-router token refresh failed: ${error}`)
    }
    const accessToken = getClaudeAIOAuthTokens()?.accessToken
    if (!accessToken) {
      throw new SearchUnavailableError('auth_required', AUTH_REQUIRED_MESSAGE)
    }

    const { signal: requestSignal, cleanup } = createCombinedAbortSignal(
      signal,
      { timeoutMs: searchTimeoutMs },
    )
    try {
      let res = await postSearch(accessToken, input, requestSignal, signal)

      if (res.status === 401) {
        // Server-side expiry the local check missed (clock skew, revocation
        // race): force one refresh and retry once with the new token.
        await res.body?.cancel().catch(() => {})
        const outcome = await handleOAuth401ErrorWithOutcome(accessToken)
        const refreshedToken = didOAuthRefreshRecover(outcome)
          ? getClaudeAIOAuthTokens()?.accessToken
          : undefined
        if (refreshedToken && refreshedToken !== accessToken) {
          res = await postSearch(refreshedToken, input, requestSignal, signal)
        }
      }

      if (!res.ok) throw await verbooRouterSearchError(res)

      let data: { results?: unknown }
      try {
        data = (await res.json()) as { results?: unknown }
      } catch (error) {
        if (signal?.aborted) throw error
        if (requestSignal.aborted) throw unreachable(requestSignal)
        throw new SearchUnavailableError(
          'temporarily_unavailable',
          TEMPORARILY_UNAVAILABLE_MESSAGE,
          { code: 'search_bad_response', status: res.status },
        )
      }
      const rawResults = Array.isArray(data?.results) ? data.results : []
      const hits = rawResults.map((r: any) => ({
        title: r?.title ?? '',
        url: r?.url ?? '',
        description: r?.content,
        source: safeHostname(r?.url),
      }))

      return {
        hits: applyDomainFilters(hits, input),
        providerName: 'verboo-router',
        durationSeconds: (performance.now() - start) / 1000,
      }
    } finally {
      cleanup()
    }
  },
}
