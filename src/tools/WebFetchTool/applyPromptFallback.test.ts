import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

// Mock the Anthropic-API-side before importing the module under test, so
// queryHaiku resolves into whatever the individual test wants (slow, failing,
// or successful). We preserve every other export from claude.js so unrelated
// transitive imports still work.
const haikuMock = mock()

beforeEach(async () => {
  haikuMock.mockReset()
  const actual = await import('../../services/api/claude.js')
  mock.module('../../services/api/claude.js', () => ({
    ...actual,
    queryHaiku: haikuMock,
  }))
})

afterEach(() => {
  mock.restore()
})

async function runApply(markdown = 'Hello world.', signal?: AbortSignal): Promise<string> {
  const nonce = `${Date.now()}-${Math.random()}`
  const { applyPromptToMarkdown } =
    await import(`./utils.js?ts=${nonce}`)
  const ctrl = new AbortController()
  return applyPromptToMarkdown(
    'summarize',
    markdown,
    signal ?? ctrl.signal,
    false,
    false,
  )
}

test('returns raw truncated markdown when queryHaiku throws', async () => {
  haikuMock.mockImplementation(async () => {
    throw new Error('MiniMax rejected the model name')
  })

  const output = await runApply('Gitlawb homepage content.')
  expect(output).toContain('[Secondary-model summarization unavailable')
  expect(output).toContain('Gitlawb homepage content.')
})

test('returns raw truncated markdown when queryHaiku simulates a timeout', async () => {
  // Simulating raceWithTimeout's rejection path directly — we can't actually
  // wait 45s in a test. The error shape matches what raceWithTimeout produces.
  haikuMock.mockImplementation(async () => {
    const err = new Error('Secondary-model summarization timed out after 45000ms')
    ;(err as NodeJS.ErrnoException).code = 'SECONDARY_MODEL_TIMEOUT'
    throw err
  })

  const output = await runApply('Slow provider content.')
  expect(output).toContain('[Secondary-model summarization unavailable')
  expect(output).toContain('Slow provider content.')
})

test('returns the model response when queryHaiku succeeds', async () => {
  haikuMock.mockImplementation(async () => ({
    message: {
      content: [{ type: 'text', text: 'This page is about GitLawb, an AI legal platform.' }],
    },
  }))

  const output = await runApply('some page content')
  expect(output).toBe('This page is about GitLawb, an AI legal platform.')
})

test('returns fallback when queryHaiku resolves with empty content', async () => {
  haikuMock.mockImplementation(async () => ({ message: { content: [] } }))

  const output = await runApply('some page content')
  expect(output).toContain('[Secondary-model summarization unavailable')
  expect(output).toContain('some page content')
})

test('propagates AbortError from the caller signal', async () => {
  const ctrl = new AbortController()
  haikuMock.mockImplementation(async () => {
    ctrl.abort()
    return new Promise(() => {})
  })

  await expect(runApply('content', ctrl.signal)).rejects.toThrow()
})

test('reads the summary after a leading thinking block (reasoning models)', async () => {
  haikuMock.mockImplementation(async () => ({
    message: {
      content: [
        { type: 'thinking', thinking: 'Let me read the page first.' },
        { type: 'text', text: 'The page documents the v2 API.' },
      ],
    },
  }))

  const output = await runApply('x'.repeat(50_000))
  expect(output).toBe('The page documents the v2 API.')
})

test('caps the raw fallback well below the 100k fetch limit and says so', async () => {
  haikuMock.mockImplementation(async () => {
    throw new Error('router unavailable')
  })
  const { MAX_FALLBACK_CONTENT_LENGTH } = await import('./utils.js')
  const page = 'a'.repeat(90_000)

  const output = await runApply(page)
  expect(MAX_FALLBACK_CONTENT_LENGTH).toBeLessThanOrEqual(20_000)
  expect(output.length).toBeLessThan(MAX_FALLBACK_CONTENT_LENGTH + 1_000)
  expect(output).toContain('the rest of the page was omitted')
  expect(output).toContain('90,000')
})

test('falls back when the model only returned thinking', async () => {
  haikuMock.mockImplementation(async () => ({
    message: { content: [{ type: 'thinking', thinking: 'Hmm.' }] },
  }))

  const output = await runApply('short page')
  expect(output).toContain('[Secondary-model summarization unavailable')
  expect(output).toContain('short page')
})
