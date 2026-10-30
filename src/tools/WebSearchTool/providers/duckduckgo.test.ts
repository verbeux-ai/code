import { describe, expect, mock, test } from 'bun:test'

const actualOauth = { ...(await import('../../../constants/oauth.js')) }
let verbooMode = false
mock.module('../../../constants/oauth.js', () => ({
  ...actualOauth,
  isVerbooMode: () => verbooMode,
}))

const { getDdgAnomalyHint } = await import('./duckduckgo.js')

describe('DuckDuckGo SafeSearchType', () => {
  test('SafeSearchType.STRICT === 0 (matches previous raw value)', async () => {
    const { SafeSearchType } = await import('duck-duck-scrape')
    expect(SafeSearchType.STRICT).toBe(0)
  })

  test('SafeSearchType enum values are sane', async () => {
    const { SafeSearchType } = await import('duck-duck-scrape')
    expect(SafeSearchType.STRICT).toBe(0)
    expect(SafeSearchType.MODERATE).toBe(-1)
    expect(SafeSearchType.OFF).toBe(-2)
  })
})

describe('DuckDuckGo rate-limit hint', () => {
  test('lists third-party search keys outside Verboo mode', () => {
    verbooMode = false
    expect(getDdgAnomalyHint()).toContain('TAVILY_API_KEY')
  })

  test('points Verboo users back to Verboo search instead of API keys', () => {
    verbooMode = true
    const hint = getDdgAnomalyHint()
    expect(hint).not.toMatch(/API_KEY/)
    expect(hint).toContain('WEB_SEARCH_PROVIDER')
    expect(hint).toContain('Verboo web search')
  })
})
