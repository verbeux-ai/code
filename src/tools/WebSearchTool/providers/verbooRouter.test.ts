import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import axios from 'axios'

// Auth is mocked so the provider never touches real credentials or the
// network; fetch is replaced per test.
const actualAuth = { ...(await import('../../../utils/auth.js')) }
let currentToken: string | null = 'token-1'
const refreshCheck = mock(async () => true)
const handle401 = mock(async (_failed: string) => 'refreshed' as const)
mock.module('../../../utils/auth.js', () => ({
  ...actualAuth,
  getClaudeAIOAuthTokens: () =>
    currentToken ? { accessToken: currentToken, refreshToken: 'refresh' } : null,
  checkAndRefreshOAuthTokenIfNeeded: refreshCheck,
  handleOAuth401ErrorWithOutcome: handle401,
}))

const {
  verbooRouterProvider,
  classifyRouterSearchFailure,
  verbooRouterSearchError,
  __test,
} = await import('./verbooRouter.js')
const { SearchUnavailableError } = await import('./types.js')
const { PaymentPastDueError } = await import(
  '../../../services/oauth/paymentPastDue.js'
)
const { clearVerbooModelsCache, fetchVerbooModels } = await import(
  '../../../services/api/verbooModels.js'
)

const originalFetch = globalThis.fetch
const originalAxiosGet = axios.get
type FetchCall = { url: string; init: RequestInit }
let calls: FetchCall[] = []

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function routerError(status: number, code: string, message = 'fixture'): Response {
  return jsonResponse(status, { error: { message, type: 'search_error', code } })
}

function useFetch(...responses: Array<Response | ((init: RequestInit) => Promise<Response>)>) {
  let index = 0
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    const next = responses[Math.min(index++, responses.length - 1)]!
    return typeof next === 'function' ? next(init) : next
  }) as typeof fetch
}

async function searchError(): Promise<unknown> {
  try {
    await verbooRouterProvider.search({ query: 'latest bun release' })
  } catch (error) {
    return error
  }
  throw new Error('expected search to fail')
}

beforeEach(() => {
  calls = []
  currentToken = 'token-1'
  refreshCheck.mockClear()
  handle401.mockClear()
  handle401.mockImplementation(async () => {
    currentToken = 'token-2'
    return 'refreshed'
  })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  axios.get = originalAxiosGet
  clearVerbooModelsCache()
  __test.setSearchTimeoutMs()
})

describe('verbooRouterProvider.search', () => {
  test('returns hits and refreshes the token proactively before searching', async () => {
    useFetch(
      jsonResponse(200, {
        results: [
          { title: 'Bun 1.3', url: 'https://bun.sh/blog', content: 'Release notes' },
        ],
      }),
    )
    const output = await verbooRouterProvider.search({ query: 'bun release' })
    expect(refreshCheck).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toEndWith('/router/v1/search')
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer token-1',
    )
    expect(output.hits).toEqual([
      {
        title: 'Bun 1.3',
        url: 'https://bun.sh/blog',
        description: 'Release notes',
        source: 'bun.sh',
      },
    ])
  })

  test('retries once with the refreshed token after a 401', async () => {
    useFetch(
      jsonResponse(401, { error: { message: 'expired' } }),
      jsonResponse(200, { results: [] }),
    )
    const output = await verbooRouterProvider.search({ query: 'q1' })
    expect(handle401).toHaveBeenCalledWith('token-1')
    expect(calls).toHaveLength(2)
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer token-2',
    )
    expect(output.hits).toEqual([])
  })

  test('reports auth_required when the refresh does not recover', async () => {
    handle401.mockImplementation(async () => 'reauth_required' as never)
    useFetch(jsonResponse(401, { error: { message: 'expired' } }))
    const error = await searchError()
    expect(error).toBeInstanceOf(SearchUnavailableError)
    expect((error as InstanceType<typeof SearchUnavailableError>).reason).toBe(
      'auth_required',
    )
    expect(calls).toHaveLength(1)
  })

  test('reports auth_required without a session token', async () => {
    currentToken = null
    useFetch(jsonResponse(200, { results: [] }))
    const error = await searchError()
    expect((error as InstanceType<typeof SearchUnavailableError>).reason).toBe(
      'auth_required',
    )
    expect(calls).toHaveLength(0)
  })

  for (const code of [
    'search_disabled',
    'search_provider_quota_exhausted',
    'search_provider_rate_limited',
    'search_provider_auth_failed',
    'search_provider_timeout',
    'search_provider_unavailable',
    'search_provider_bad_response',
  ]) {
    test(`maps 503 ${code} to temporarily_unavailable`, async () => {
      useFetch(routerError(503, code))
      const error = (await searchError()) as InstanceType<typeof SearchUnavailableError>
      expect(error).toBeInstanceOf(SearchUnavailableError)
      expect(error.reason).toBe('temporarily_unavailable')
      expect(error.code).toBe(code)
      expect(error.message).not.toMatch(/API_KEY/)
    })
  }

  test('maps 403 search_access_required to plan_required', async () => {
    useFetch(routerError(403, 'search_access_required'))
    const error = (await searchError()) as InstanceType<typeof SearchUnavailableError>
    expect(error.reason).toBe('plan_required')
    expect(error.message).toMatch(/active Verboo plan/)
  })

  test('keeps other client errors as real errors', async () => {
    useFetch(routerError(400, 'invalid_query', 'query too long'))
    const error = await searchError()
    expect(error).not.toBeInstanceOf(SearchUnavailableError)
    expect((error as Error).message).toContain('400')
    expect((error as Error).message).toContain('query too long')
  })

  test('a past-due subscription surfaces the billing message', async () => {
    useFetch(
      jsonResponse(402, {
        error: {
          message:
            'Payment past due: the renewal of your Verboo Code subscription failed, so access is paused. Pay the open invoice at https://code.verboo.ai/en/settings/billing to restore access.',
          type: 'billing_error',
          code: 'payment_past_due',
        },
      }),
    )
    const error = await searchError()
    expect(error).toBeInstanceOf(PaymentPastDueError)
    expect(error).not.toBeInstanceOf(SearchUnavailableError)
  })

  test('maps network failures to temporarily_unavailable', async () => {
    useFetch(async () => {
      throw new TypeError('fetch failed')
    })
    const error = (await searchError()) as InstanceType<typeof SearchUnavailableError>
    expect(error.reason).toBe('temporarily_unavailable')
    expect(error.code).toBe('search_network_error')
  })

  test('times out a hung request as temporarily_unavailable', async () => {
    __test.setSearchTimeoutMs(20)
    useFetch(
      init =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason ?? new Error('aborted')),
          )
        }),
    )
    const error = (await searchError()) as InstanceType<typeof SearchUnavailableError>
    expect(error.reason).toBe('temporarily_unavailable')
    expect(error.code).toBe('search_timeout')
  })

  test('a user interrupt stays an abort, not "unavailable"', async () => {
    const controller = new AbortController()
    useFetch(
      init =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          )
          controller.abort()
        }),
    )
    const error = await verbooRouterProvider
      .search({ query: 'q' }, controller.signal)
      .catch(e => e)
    expect(error).not.toBeInstanceOf(SearchUnavailableError)
    expect((error as Error).name).toBe('AbortError')
  })

  test('skips the request when /models says web search is disabled', async () => {
    axios.get = mock(async () => ({
      data: {
        data: [{ id: 'ultra/glm' }],
        capabilities: { web_search: false },
      },
    })) as typeof axios.get
    await fetchVerbooModels('token-1', { force: true })
    useFetch(jsonResponse(200, { results: [] }))
    const error = (await searchError()) as InstanceType<typeof SearchUnavailableError>
    expect(error.reason).toBe('temporarily_unavailable')
    expect(error.code).toBe('search_disabled')
    expect(calls).toHaveLength(0)
  })

  test('calls the router when /models says web search is enabled or omits it', async () => {
    for (const capabilities of [{ web_search: true }, undefined]) {
      calls = []
      axios.get = mock(async () => ({
        data: { data: [{ id: 'ultra/glm' }], capabilities },
      })) as typeof axios.get
      await fetchVerbooModels('token-1', { force: true })
      useFetch(jsonResponse(200, { results: [] }))
      await verbooRouterProvider.search({ query: 'q' })
      expect(calls).toHaveLength(1)
    }
  })
})

describe('classifyRouterSearchFailure', () => {
  test('treats unknown 5xx and 429 as temporary', () => {
    expect(classifyRouterSearchFailure(502, {})?.reason).toBe('temporarily_unavailable')
    expect(classifyRouterSearchFailure(429, {})?.reason).toBe('temporarily_unavailable')
  })

  test('does not treat an unrelated 403 as a plan problem', () => {
    expect(classifyRouterSearchFailure(403, { code: 'forbidden' })).toBeNull()
  })
})

describe('verbooRouterSearchError', () => {
  test('a past-due 402 from router search shows the billing link instead of the raw body', async () => {
    const error = await verbooRouterSearchError(
      new Response(
        JSON.stringify({
          error: {
            message:
              'Payment past due: the renewal of your Verboo Code subscription failed, so access is paused. Pay the open invoice at https://code.verboo.ai/en/settings/billing to restore access.',
            type: 'billing_error',
            code: 'payment_past_due',
          },
        }),
        { status: 402, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    expect(error).toBeInstanceOf(PaymentPastDueError)
    expect(error.message).toBe(
      'Pagamento pendente: a renovação da sua assinatura Verboo Code falhou e o acesso está pausado. Pague a fatura em aberto em https://code.verboo.ai/pt/settings/billing para liberar o acesso.',
    )
  })

  test('router outages become "temporarily unavailable" instead of the raw body', async () => {
    const error = await verbooRouterSearchError(
      new Response('{"error":{"code":"upstream_unavailable"}}', { status: 502 }),
    )

    expect(error).toBeInstanceOf(SearchUnavailableError)
    expect((error as InstanceType<typeof SearchUnavailableError>).reason).toBe(
      'temporarily_unavailable',
    )
  })

  test('other router search failures keep the raw status and body', async () => {
    const error = await verbooRouterSearchError(
      new Response('{"error":{"code":"invalid_query"}}', { status: 400 }),
    )

    expect(error).not.toBeInstanceOf(PaymentPastDueError)
    expect(error).not.toBeInstanceOf(SearchUnavailableError)
    expect(error.message).toBe(
      'verboo-router search error 400: {"error":{"code":"invalid_query"}}',
    )
  })
})
