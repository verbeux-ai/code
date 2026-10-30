import { beforeEach, describe, expect, mock, test } from 'bun:test'

const actualOauth = { ...(await import('../../constants/oauth.js')) }
mock.module('../../constants/oauth.js', () => ({
  ...actualOauth,
  isVerbooMode: () => true,
}))

// The native Anthropic path must never run in Verboo mode: the router cannot
// execute the server-side web_search tool.
const nativeQuery = mock(() => {
  throw new Error('native web_search path must not run in Verboo mode')
})
const actualClaude = { ...(await import('../../services/api/claude.js')) }
mock.module('../../services/api/claude.js', () => ({
  ...actualClaude,
  queryModelWithStreaming: nativeQuery,
}))

const runSearchMock = mock(async (): Promise<unknown> => ({
  hits: [],
  providerName: 'verboo-router',
  durationSeconds: 0.1,
}))
const actualProviders = { ...(await import('./providers/index.js')) }
mock.module('./providers/index.js', () => ({
  ...actualProviders,
  runSearch: runSearchMock,
}))

const { WebSearchTool } = await import('./WebSearchTool.js')
const { SearchUnavailableError } = await import('./providers/types.js')

type Output = Awaited<ReturnType<typeof WebSearchTool.call>>['data']

const fakeContext = () =>
  ({ abortController: new AbortController() }) as unknown as Parameters<
    typeof WebSearchTool.call
  >[1]

async function callTool(query = 'latest bun release'): Promise<Output> {
  const result = await WebSearchTool.call(
    { query },
    fakeContext(),
    undefined as never,
    undefined as never,
    undefined,
  )
  return result.data
}

function toModelText(output: Output): string {
  const block = WebSearchTool.mapToolResultToToolResultBlockParam(output, 'tool-1')
  return String(block.content)
}

beforeEach(() => {
  runSearchMock.mockReset()
  nativeQuery.mockClear()
})

describe('WebSearch in Verboo mode', () => {
  test('stays enabled even when search may be unavailable', () => {
    expect(WebSearchTool.isEnabled()).toBe(true)
  })

  test('returns router hits with the source reminder', async () => {
    runSearchMock.mockImplementation(async () => ({
      hits: [{ title: 'Bun', url: 'https://bun.sh', description: 'Runtime' }],
      providerName: 'verboo-router',
      durationSeconds: 0.2,
    }))
    const output = await callTool()
    expect(output.unavailable).toBeUndefined()
    const text = toModelText(output)
    expect(text).toContain('https://bun.sh')
    expect(text).toContain('REMINDER')
  })

  test('zero hits never falls back to the native path or asks for API keys', async () => {
    runSearchMock.mockImplementation(async () => ({
      hits: [],
      providerName: 'verboo-router',
      durationSeconds: 0.2,
    }))
    const output = await callTool()
    expect(nativeQuery).not.toHaveBeenCalled()
    const text = toModelText(output)
    expect(text).toContain('No results found.')
    expect(text).toContain('Do not invent sources')
    expect(text).not.toContain('REMINDER')
    expect(text).not.toMatch(/API_KEY/)
  })

  test('search disabled returns a non-error "temporarily unavailable" result', async () => {
    runSearchMock.mockImplementation(async () => {
      throw new SearchUnavailableError(
        'temporarily_unavailable',
        'Verboo web search is temporarily unavailable.',
        { code: 'search_disabled', status: 503 },
      )
    })
    const output = await callTool('who won the match yesterday')
    expect(nativeQuery).not.toHaveBeenCalled()
    expect(output.unavailable?.reason).toBe('temporarily_unavailable')
    expect(output.results).toEqual([])
    const text = toModelText(output)
    expect(text).toContain('temporarily unavailable')
    expect(text).toContain('tell the user that web search was unavailable')
    expect(text).toContain('Do not invent sources')
    expect(text).not.toContain('REMINDER')
    expect(text).not.toMatch(/API_KEY|DuckDuckGo/)
  })

  test('no active plan tells the model search requires a Verboo plan', async () => {
    runSearchMock.mockImplementation(async () => {
      throw new SearchUnavailableError(
        'plan_required',
        'Web search requires an active Verboo plan.',
        { code: 'search_access_required', status: 403 },
      )
    })
    const output = await callTool()
    expect(output.unavailable?.reason).toBe('plan_required')
    expect(toModelText(output)).toContain('requires an active Verboo plan')
  })

  test('finds the router outcome inside an aggregated auto-mode failure', async () => {
    runSearchMock.mockImplementation(async () => {
      const combined = new Error('All 2 search providers failed')
      ;(combined as Error & { causes: Error[] }).causes = [
        new SearchUnavailableError('temporarily_unavailable', 'unavailable'),
        new Error('tavily returned 500'),
      ]
      throw combined
    })
    const output = await callTool()
    expect(output.unavailable?.reason).toBe('temporarily_unavailable')
  })

  test('real errors still surface as errors', async () => {
    runSearchMock.mockImplementation(async () => {
      throw new Error('verboo-router search error 400: query too long')
    })
    await expect(callTool()).rejects.toThrow('query too long')
    expect(nativeQuery).not.toHaveBeenCalled()
  })
})
