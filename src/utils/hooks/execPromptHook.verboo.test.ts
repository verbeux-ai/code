import { beforeEach, describe, expect, mock, test } from 'bun:test'

type QueryArgs = { options: { model?: string; outputFormat?: unknown } }
let reply = ''
const queryModelWithoutStreaming = mock(async (_args: QueryArgs): Promise<unknown> => ({
  message: { content: [{ type: 'thinking', thinking: 'checking' }, { type: 'text', text: reply }] },
}))
const actualClaude = { ...(await import('../../services/api/claude.js')) }
mock.module('../../services/api/claude.js', () => ({
  ...actualClaude,
  queryModelWithoutStreaming,
}))

let structuredSupported = false
const actualFast = { ...(await import('../../services/api/verbooFastModel.js')) }
mock.module('../../services/api/verbooFastModel.js', () => ({
  ...actualFast,
  getSideQueryModel: () => 'ultra/qwen3.8-27b',
  sideQuerySupportsStructuredOutput: () => structuredSupported,
}))

const { execPromptHook } = await import('./execPromptHook.js')

const toolUseContext = {
  options: { tools: [] },
  getAppState: () => ({ toolPermissionContext: {} }),
  setResponseLength: () => {},
  agentId: undefined,
} as unknown as Parameters<typeof execPromptHook>[5]

const run = () =>
  execPromptHook(
    { type: 'prompt', prompt: 'Were the tests run? $ARGUMENTS' } as Parameters<typeof execPromptHook>[0],
    'Stop',
    'Stop',
    '{}',
    new AbortController().signal,
    toolUseContext,
  )

beforeEach(() => {
  queryModelWithoutStreaming.mockClear()
  structuredSupported = false
})

describe('execPromptHook without structured output', () => {
  test('uses the fast model, omits output_format and reads JSON wrapped in prose', async () => {
    reply = 'Here you go: {"ok": false, "reason": "tests were not run"}'
    const result = await run()
    const args = queryModelWithoutStreaming.mock.calls[0]![0]
    expect(args.options.model).toBe('ultra/qwen3.8-27b')
    expect(args.options.outputFormat).toBeUndefined()
    expect(result.outcome).toBe('blocking')
    expect(result.stopReason).toBe('tests were not run')
  })

  test('still requests structured output where the model accepts it', async () => {
    structuredSupported = true
    reply = '{"ok": true}'
    const result = await run()
    expect(queryModelWithoutStreaming.mock.calls[0]![0].options.outputFormat).toBeDefined()
    expect(result.outcome).toBe('success')
  })
})
