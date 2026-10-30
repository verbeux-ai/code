import { describe, expect, mock, test, beforeEach, afterEach } from 'bun:test'

// Verboo Code always runs in Verboo mode; the generic suites below pin the
// non-Verboo provider behavior, and the Verboo suite at the end flips it.
const actualOauth = { ...(await import('../../../constants/oauth.js')) }
let verbooMode = false
mock.module('../../../constants/oauth.js', () => ({
  ...actualOauth,
  isVerbooMode: () => verbooMode,
}))
beforeEach(() => {
  verbooMode = false
})

const { getProviderMode, getProviderChain, getAvailableProviders, runSearch } =
  await import('./index.js')
const { findSearchUnavailableError, SearchUnavailableError } = await import(
  './types.js'
)
type ProviderMode = import('./index.js').ProviderMode

// ---------------------------------------------------------------------------
// getProviderMode
// ---------------------------------------------------------------------------

describe('getProviderMode', () => {
  const savedEnv = process.env.WEB_SEARCH_PROVIDER

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.WEB_SEARCH_PROVIDER
    } else {
      process.env.WEB_SEARCH_PROVIDER = savedEnv
    }
  })

  test('returns auto by default', () => {
    delete process.env.WEB_SEARCH_PROVIDER
    expect(getProviderMode()).toBe('auto')
  })

  test('returns configured mode', () => {
    process.env.WEB_SEARCH_PROVIDER = 'tavily'
    expect(getProviderMode()).toBe('tavily')
  })

  test('returns ddg mode', () => {
    process.env.WEB_SEARCH_PROVIDER = 'ddg'
    expect(getProviderMode()).toBe('ddg')
  })

  test('returns native mode', () => {
    process.env.WEB_SEARCH_PROVIDER = 'native'
    expect(getProviderMode()).toBe('native')
  })

  test('falls back to auto for invalid mode', () => {
    process.env.WEB_SEARCH_PROVIDER = 'nonexistent_provider'
    expect(getProviderMode()).toBe('auto')
  })
})

// ---------------------------------------------------------------------------
// getProviderChain
// ---------------------------------------------------------------------------

describe('getProviderChain', () => {
  test('auto mode returns at least one configured provider', () => {
    // DDG isAlways configured (no API key needed)
    const chain = getProviderChain('auto')
    expect(chain.length).toBeGreaterThan(0)
    expect(chain.some(p => p.name === 'duckduckgo')).toBe(true)
  })

  test('auto mode does NOT include custom provider', () => {
    const chain = getProviderChain('auto')
    expect(chain.some(p => p.name === 'custom')).toBe(false)
  })

  test('custom mode explicitly returns custom provider', () => {
    const chain = getProviderChain('custom' as ProviderMode)
    expect(chain).toHaveLength(1)
    expect(chain[0].name).toBe('custom')
  })

  test('specific mode returns exactly one provider', () => {
    const chain = getProviderChain('tavily' as ProviderMode)
    expect(chain).toHaveLength(1)
    expect(chain[0].name).toBe('tavily')
  })

  test('ddg mode returns duckduckgo provider', () => {
    const chain = getProviderChain('ddg' as ProviderMode)
    expect(chain).toHaveLength(1)
    expect(chain[0].name).toBe('duckduckgo')
  })

  test('native mode returns empty chain', () => {
    expect(getProviderChain('native')).toHaveLength(0)
  })

  test('unknown mode returns empty chain', () => {
    expect(getProviderChain('nonexistent' as ProviderMode)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// AbortError stops the chain
// ---------------------------------------------------------------------------

describe('runSearch', () => {
  test('AbortError stops the chain immediately in auto mode', async () => {
    // Use AbortController to cancel
    const controller = new AbortController()
    controller.abort() // cancel immediately

    await expect(
      // Dynamic import to avoid circular issues
      import('./index.js').then(m =>
        m.runSearch({ query: 'test' }, controller.signal),
      ),
    ).rejects.toThrow()
  })

  test('explicit mode fails fast when provider is not configured', async () => {
    // Save and clear tavily key
    const saved = process.env.TAVILY_API_KEY
    delete process.env.TAVILY_API_KEY
    const savedProvider = process.env.WEB_SEARCH_PROVIDER
    process.env.WEB_SEARCH_PROVIDER = 'tavily'

    try {
      const { runSearch } = await import('./index.js')
      await expect(runSearch({ query: 'test' })).rejects.toThrow(
        /not configured/i,
      )
    } finally {
      if (saved !== undefined) process.env.TAVILY_API_KEY = saved
      else delete process.env.TAVILY_API_KEY
      if (savedProvider !== undefined) process.env.WEB_SEARCH_PROVIDER = savedProvider
      else delete process.env.WEB_SEARCH_PROVIDER
    }
  })
})

// ---------------------------------------------------------------------------
// getAvailableProviders
// ---------------------------------------------------------------------------

describe('getAvailableProviders', () => {
  test('always includes duckduckgo (no API key required)', () => {
    const providers = getAvailableProviders()
    expect(providers.some(p => p.name === 'duckduckgo')).toBe(true)
  })

  test('does NOT include custom in available providers (auto chain)', () => {
    const providers = getAvailableProviders()
    expect(providers.some(p => p.name === 'custom')).toBe(false)
  })

  test('includes providers when API keys are set', () => {
    const saved = process.env.TAVILY_API_KEY
    process.env.TAVILY_API_KEY = 'test-key'
    const providers = getAvailableProviders()
    expect(providers.some(p => p.name === 'tavily')).toBe(true)
    if (saved === undefined) delete process.env.TAVILY_API_KEY
    else process.env.TAVILY_API_KEY = saved
  })

  test('excludes providers when API keys are missing', () => {
    const saved = process.env.TAVILY_API_KEY
    delete process.env.TAVILY_API_KEY
    const providers = getAvailableProviders()
    expect(providers.some(p => p.name === 'tavily')).toBe(false)
    if (saved !== undefined) process.env.TAVILY_API_KEY = saved
  })
})

// ---------------------------------------------------------------------------
// Verboo mode
// ---------------------------------------------------------------------------

describe('Verboo mode provider selection', () => {
  const savedEnv = {
    WEB_SEARCH_PROVIDER: process.env.WEB_SEARCH_PROVIDER,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
  }

  beforeEach(() => {
    verbooMode = true
    delete process.env.WEB_SEARCH_PROVIDER
    delete process.env.TAVILY_API_KEY
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test('auto chain is only the Verboo router (no DuckDuckGo fallback)', () => {
    expect(getProviderChain('auto').map(p => p.name)).toEqual(['verboo-router'])
    expect(getAvailableProviders().map(p => p.name)).toEqual(['verboo-router'])
  })

  test('explicitly configured keys still join the auto chain after the router', () => {
    process.env.TAVILY_API_KEY = 'test-key'
    expect(getProviderChain('auto').map(p => p.name)).toEqual([
      'verboo-router',
      'tavily',
    ])
  })

  test('explicit WEB_SEARCH_PROVIDER=ddg keeps working', () => {
    process.env.WEB_SEARCH_PROVIDER = 'ddg'
    expect(getProviderMode()).toBe('ddg')
    expect(getProviderChain('ddg').map(p => p.name)).toEqual(['duckduckgo'])
  })

  test('"native" maps to the router (it cannot run Anthropic web_search)', () => {
    process.env.WEB_SEARCH_PROVIDER = 'native'
    expect(getProviderMode()).toBe('auto')
  })
})

describe('runSearch error aggregation', () => {
  test('keeps typed causes when several providers fail', async () => {
    const savedProvider = process.env.WEB_SEARCH_PROVIDER
    const savedTavily = process.env.TAVILY_API_KEY
    const originalFetch = globalThis.fetch
    verbooMode = true
    delete process.env.WEB_SEARCH_PROVIDER
    process.env.TAVILY_API_KEY = 'test-key'
    const { verbooRouterProvider } = await import('./verbooRouter.js')
    const { tavilyProvider } = await import('./tavily.js')
    const routerSearch = verbooRouterProvider.search
    const tavilySearch = tavilyProvider.search
    const unavailable = new SearchUnavailableError(
      'temporarily_unavailable',
      'Verboo web search is temporarily unavailable.',
      { code: 'search_disabled' },
    )
    ;(verbooRouterProvider as { search: typeof routerSearch }).search = async () => {
      throw unavailable
    }
    ;(tavilyProvider as { search: typeof tavilySearch }).search = async () => {
      throw new Error('tavily returned 500')
    }
    const consoleError = console.error
    console.error = () => {}
    try {
      const error = await runSearch({ query: 'test' }).catch(e => e)
      expect((error as Error).message).toContain('All 2 search providers failed')
      expect(findSearchUnavailableError(error)).toBe(unavailable)
    } finally {
      console.error = consoleError
      ;(verbooRouterProvider as { search: typeof routerSearch }).search = routerSearch
      ;(tavilyProvider as { search: typeof tavilySearch }).search = tavilySearch
      globalThis.fetch = originalFetch
      if (savedProvider === undefined) delete process.env.WEB_SEARCH_PROVIDER
      else process.env.WEB_SEARCH_PROVIDER = savedProvider
      if (savedTavily === undefined) delete process.env.TAVILY_API_KEY
      else process.env.TAVILY_API_KEY = savedTavily
    }
  })
})
