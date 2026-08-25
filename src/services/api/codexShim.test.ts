import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../../test/sharedMutationLock.js'
import {
  codexStreamToAnthropic,
  collectCodexCompletedResponse,
  convertAnthropicMessagesToResponsesInput,
  convertCodexResponseToAnthropicMessage,
  convertSystemPrompt,
  convertToolsToResponsesTools,
  type AnthropicStreamEvent,
} from './codexShim.js'
import { __test as webSearchToolTest } from '../../tools/WebSearchTool/WebSearchTool.js'

const tempDirs: string[] = []
const originalEnv = {
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_BASE: process.env.OPENAI_API_BASE,
  CLAUDE_CODE_USE_GITHUB: process.env.CLAUDE_CODE_USE_GITHUB,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  VERBOO_STREAM_IDLE_TIMEOUT_MS: process.env.VERBOO_STREAM_IDLE_TIMEOUT_MS,
  VERBOO_MAX_BUFFERED_TOOL_ARGUMENT_CHARS:
    process.env.VERBOO_MAX_BUFFERED_TOOL_ARGUMENT_CHARS,
}

beforeEach(async () => {
  await acquireSharedMutationLock('codexShim.test.ts')
})

afterEach(() => {
  try {
    if (originalEnv.OPENAI_BASE_URL === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = originalEnv.OPENAI_BASE_URL

    if (originalEnv.OPENAI_API_BASE === undefined) delete process.env.OPENAI_API_BASE
    else process.env.OPENAI_API_BASE = originalEnv.OPENAI_API_BASE

    if (originalEnv.CLAUDE_CODE_USE_GITHUB === undefined) delete process.env.CLAUDE_CODE_USE_GITHUB
    else process.env.CLAUDE_CODE_USE_GITHUB = originalEnv.CLAUDE_CODE_USE_GITHUB

    if (originalEnv.OPENAI_MODEL === undefined) delete process.env.OPENAI_MODEL
    else process.env.OPENAI_MODEL = originalEnv.OPENAI_MODEL

    if (originalEnv.VERBOO_STREAM_IDLE_TIMEOUT_MS === undefined) {
      delete process.env.VERBOO_STREAM_IDLE_TIMEOUT_MS
    } else {
      process.env.VERBOO_STREAM_IDLE_TIMEOUT_MS =
        originalEnv.VERBOO_STREAM_IDLE_TIMEOUT_MS
    }

    if (originalEnv.VERBOO_MAX_BUFFERED_TOOL_ARGUMENT_CHARS === undefined) {
      delete process.env.VERBOO_MAX_BUFFERED_TOOL_ARGUMENT_CHARS
    } else {
      process.env.VERBOO_MAX_BUFFERED_TOOL_ARGUMENT_CHARS =
        originalEnv.VERBOO_MAX_BUFFERED_TOOL_ARGUMENT_CHARS
    }

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  } finally {
    releaseSharedMutationLock()
  }
})

function createTempAuthJson(payload: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'verboo-codex-'))
  tempDirs.push(dir)
  const authPath = join(dir, 'auth.json')
  writeFileSync(authPath, JSON.stringify(payload), 'utf8')
  return authPath
}

async function collectStreamEventTypes(responseText: string): Promise<string[]> {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(responseText))
      controller.close()
    },
  })

  const events: string[] = []
  for await (const event of codexStreamToAnthropic(new Response(stream), 'gpt-5.4')) {
    events.push(event.type)
  }
  return events
}

async function importFreshProviderConfigModule() {
  return import(`./providerConfig.js?ts=${Date.now()}-${Math.random()}`)
}

describe('Codex provider config', () => {
  const originalOpenaiBaseUrl = process.env.OPENAI_BASE_URL
  const originalOpenaiApiBase = process.env.OPENAI_API_BASE

  beforeEach(() => {
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_BASE
  })

  afterEach(() => {
    if (originalOpenaiBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = originalOpenaiBaseUrl
    if (originalOpenaiApiBase === undefined) delete process.env.OPENAI_API_BASE
    else process.env.OPENAI_API_BASE = originalOpenaiApiBase
  })

  test('resolves codexplan alias to Codex transport with reasoning', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_BASE
    delete process.env.CLAUDE_CODE_USE_GITHUB

    const resolved = resolveProviderRequest({ model: 'codexplan' })
    expect(resolved.transport).toBe('codex_responses')
    expect(resolved.resolvedModel).toBe('gpt-5.5')
    expect(resolved.reasoning).toEqual({ effort: 'high' })
    expect(resolved.baseUrl).toBe('https://chatgpt.com/backend-api/codex')
  })

  test('resolves codexspark alias to Codex transport with Codex base URL', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_BASE
    delete process.env.CLAUDE_CODE_USE_GITHUB

    const resolved = resolveProviderRequest({ model: 'codexspark' })
    expect(resolved.transport).toBe('codex_responses')
    expect(resolved.resolvedModel).toBe('gpt-5.3-codex-spark')
    expect(resolved.baseUrl).toBe('https://chatgpt.com/backend-api/codex')
  })

  test('does not force Codex transport when a local non-Codex base URL is explicit', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    const resolved = resolveProviderRequest({
      model: 'codexplan',
      baseUrl: 'http://127.0.0.1:8080/v1',
    })

    expect(resolved.transport).toBe('chat_completions')
    expect(resolved.baseUrl).toBe('http://127.0.0.1:8080/v1')
    expect(resolved.resolvedModel).toBe('gpt-5.5')
  })

  test('resolves codexplan to Codex transport even when OPENAI_BASE_URL is the string "undefined"', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    // On Windows, env vars can leak as the literal string "undefined" instead of
    // the JS value undefined when not properly unset (issue #336).
    process.env.OPENAI_BASE_URL = 'undefined'
    const resolved = resolveProviderRequest({ model: 'codexplan' })
    expect(resolved.transport).toBe('codex_responses')
  })

  test('resolves codexplan to Codex transport even when OPENAI_BASE_URL is an empty string', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    process.env.OPENAI_BASE_URL = ''
    const resolved = resolveProviderRequest({ model: 'codexplan' })
    expect(resolved.transport).toBe('codex_responses')
  })

  test('prefers explicit baseUrl option over env var', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    process.env.OPENAI_BASE_URL = 'https://example.com/v1'
    const resolved = resolveProviderRequest({ model: 'codexplan', baseUrl: 'https://chatgpt.com/backend-api/codex' })
    expect(resolved.transport).toBe('codex_responses')
    expect(resolved.baseUrl).toBe('https://chatgpt.com/backend-api/codex')
  })

  test('default gpt-4o uses OpenAI base URL (no regression)', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    delete process.env.OPENAI_BASE_URL
    delete process.env.CLAUDE_CODE_USE_GITHUB

    const resolved = resolveProviderRequest({ model: 'gpt-4o' })
    expect(resolved.transport).toBe('chat_completions')
    expect(resolved.baseUrl).toBe('https://api.openai.com/v1')
    expect(resolved.resolvedModel).toBe('gpt-4o')
  })

  test('resolves codexplan from env var OPENAI_MODEL to Codex endpoint', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    process.env.OPENAI_MODEL = 'codexplan'
    delete process.env.OPENAI_BASE_URL
    delete process.env.CLAUDE_CODE_USE_GITHUB

    const resolved = resolveProviderRequest()
    expect(resolved.transport).toBe('codex_responses')
    expect(resolved.baseUrl).toBe('https://chatgpt.com/backend-api/codex')
    expect(resolved.resolvedModel).toBe('gpt-5.5')
  })

  test('does not override custom base URL for codexplan (e.g., local provider)', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    process.env.OPENAI_MODEL = 'codexplan'
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
    delete process.env.CLAUDE_CODE_USE_GITHUB

    const resolved = resolveProviderRequest()
    expect(resolved.transport).toBe('chat_completions')
    expect(resolved.baseUrl).toBe('http://localhost:11434/v1')
  })

  test('loads Codex credentials from auth.json fallback', async () => {
    const { resolveCodexApiCredentials } = await importFreshProviderConfigModule()
    const authPath = createTempAuthJson({
      tokens: {
        access_token: 'header.payload.signature',
        account_id: 'acct_test',
      },
    })

    const credentials = resolveCodexApiCredentials({
      CODEX_AUTH_JSON_PATH: authPath,
    } as NodeJS.ProcessEnv)

    expect(credentials.apiKey).toBe('header.payload.signature')
    expect(credentials.accountId).toBe('acct_test')
    expect(credentials.source).toBe('auth.json')
  })

  test('does not treat auth.json id_token as a Codex bearer credential', async () => {
    const { resolveCodexApiCredentials } = await importFreshProviderConfigModule()
    const idTokenPayload = Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'acct_from_id_token',
        },
      }),
      'utf8',
    ).toString('base64url')
    const authPath = createTempAuthJson({
      tokens: {
        id_token: `header.${idTokenPayload}.signature`,
      },
    })

    const credentials = resolveCodexApiCredentials({
      CODEX_AUTH_JSON_PATH: authPath,
    } as NodeJS.ProcessEnv)

    expect(credentials.apiKey).toBe('')
    expect(credentials.accountId).toBe('acct_from_id_token')
    expect(credentials.source).toBe('none')
  })
})

describe('Codex request translation', () => {
  test('normalizes optional parameters into strict Responses schemas', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'Agent',
        description: 'Spawn a sub-agent',
        input_schema: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            prompt: { type: 'string' },
            subagent_type: { type: 'string' },
          },
          required: ['description', 'prompt'],
          additionalProperties: false,
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'Agent',
        description: 'Spawn a sub-agent',
        parameters: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            prompt: { type: 'string' },
            subagent_type: { type: 'string' },
          },
          required: ['description', 'prompt', 'subagent_type'],
          additionalProperties: false,
        },
        strict: true,
      },
    ])
  })

  test('keeps strict mode for tools whose schema already matches Responses requirements', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'Ping',
        description: 'Ping tool',
        input_schema: {
          type: 'object',
          properties: {
            value: { type: 'string' },
          },
          required: ['value'],
          additionalProperties: false,
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'Ping',
        description: 'Ping tool',
        parameters: {
          type: 'object',
          properties: {
            value: { type: 'string' },
          },
          required: ['value'],
          additionalProperties: false,
        },
        strict: true,
      },
    ])
  })

  test('preserves Grep tool pattern field in Codex strict schemas', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'Grep',
        description: 'Search file contents',
        input_schema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Search pattern' },
            path: { type: 'string' },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'Grep',
        description: 'Search file contents',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Search pattern' },
            path: { type: 'string' },
          },
          required: ['pattern', 'path'],
          additionalProperties: false,
        },
        strict: true,
      },
    ])
  })

  test('preserves Glob tool pattern field in Codex strict schemas', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'Glob',
        description: 'Find files by pattern',
        input_schema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Glob pattern' },
            path: { type: 'string' },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'Glob',
        description: 'Find files by pattern',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Glob pattern' },
            path: { type: 'string' },
          },
          required: ['pattern', 'path'],
          additionalProperties: false,
        },
        strict: true,
      },
    ])
  })

  test('strips validator pattern keyword but keeps string field named pattern in Codex schemas', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'RegexProbe',
        description: 'Probe regex schema handling',
        input_schema: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              pattern: '^[a-z]+$',
            },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'RegexProbe',
        description: 'Probe regex schema handling',
        parameters: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
            },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
        strict: true,
      },
    ])
  })

  test('removes unsupported uri format from strict Responses schemas', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'WebFetch',
        description: 'Fetch a URL',
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string', format: 'uri' },
            prompt: { type: 'string' },
          },
          required: ['url', 'prompt'],
          additionalProperties: false,
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'WebFetch',
        description: 'Fetch a URL',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            prompt: { type: 'string' },
          },
          required: ['url', 'prompt'],
          additionalProperties: false,
        },
        strict: true,
      },
    ])
  })

  test('sanitizes malformed enum/default values for Responses tool schemas', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'mcp__clientry__create_task',
        description: 'Create a task',
        input_schema: {
          type: 'object',
          properties: {
            priority: {
              type: 'integer',
              description: 'Priority: 0=low, 1=medium, 2=high, 3=urgent',
              default: true,
              enum: [false, 0, 1, 2, 3],
            },
          },
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'mcp__clientry__create_task',
        description: 'Create a task',
        parameters: {
          type: 'object',
          properties: {
            priority: {
              type: 'integer',
              description: 'Priority: 0=low, 1=medium, 2=high, 3=urgent',
              enum: [0, 1, 2, 3],
            },
          },
          required: ['priority'],
          additionalProperties: false,
        },
        strict: true,
      },
    ])
  })

  test('defaults untyped MCP tool properties to string for Codex strict mode (issue #1114)', () => {
    // Repro from issue #1114: MCP server (Ruflo) registers a `value` parameter
    // with no `type`, which makes Codex strict mode 400 with
    // "schema must have a 'type' key".
    const tools = convertToolsToResponsesTools([
      {
        name: 'mcp__ruflo__config_set',
        description: 'Set a Ruflo config value',
        input_schema: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            value: { description: 'Any JSON value' },
          },
          required: ['key', 'value'],
        },
      },
    ])

    const valueSchema = (tools[0].parameters as Record<string, Record<string, Record<string, unknown>>>).properties.value
    expect(valueSchema.type).toBe('string')
    expect(valueSchema.description).toBe('Any JSON value')
  })

  test('drops orphan required keys when Ruflo MCP schema has no properties', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'mcp__ruflo__daa_workflow_create',
        description: 'Create a Ruflo DAA workflow',
        input_schema: {
          type: 'object',
          required: ['steps'],
        },
      },
    ])

    expect(tools[0].parameters).toEqual({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    })
  })

  test('infers object type for untyped schemas with nested properties', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'mcp__nest__call',
        input_schema: {
          type: 'object',
          properties: {
            payload: {
              properties: { name: { type: 'string' } },
            },
          },
        },
      },
    ])

    const payload = (tools[0].parameters as Record<string, Record<string, Record<string, unknown>>>).properties.payload
    expect(payload.type).toBe('object')
  })

  test('infers array type for untyped schemas with items', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'mcp__list__call',
        input_schema: {
          type: 'object',
          properties: {
            tags: { items: { type: 'string' } },
          },
        },
      },
    ])

    const tags = (tools[0].parameters as Record<string, Record<string, Record<string, unknown>>>).properties.tags
    expect(tags.type).toBe('array')
  })

  test('infers type from enum values when type is missing', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'mcp__enum__call',
        input_schema: {
          type: 'object',
          properties: {
            mode: { enum: ['fast', 'slow'] },
            level: { enum: [1, 2, 3] },
            ratio: { enum: [0.5, 1.5] },
            flag: { enum: [true, false] },
          },
        },
      },
    ])

    const props = (tools[0].parameters as Record<string, Record<string, Record<string, unknown>>>).properties
    expect(props.mode.type).toBe('string')
    expect(props.level.type).toBe('integer')
    expect(props.ratio.type).toBe('number')
    expect(props.flag.type).toBe('boolean')
  })

  test('leaves combinator-only schemas untyped to preserve alternatives', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'mcp__combo__call',
        input_schema: {
          type: 'object',
          properties: {
            either: {
              anyOf: [{ type: 'string' }, { type: 'number' }],
            },
          },
        },
      },
    ])

    const either = (tools[0].parameters as Record<string, Record<string, Record<string, unknown>>>).properties.either
    expect(either.type).toBeUndefined()
    expect(either.anyOf).toEqual([{ type: 'string' }, { type: 'number' }])
  })

  test('converts assistant tool use and user tool result into Responses items', () => {
    const items = convertAnthropicMessagesToResponsesInput([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Working...' },
          { type: 'tool_use', id: 'call_123', name: 'search', input: { q: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_123', content: 'done' },
        ],
      },
    ])

    expect(items).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Working...' }],
      },
      {
        type: 'function_call',
        id: 'fc_123',
        call_id: 'call_123',
        name: 'search',
        arguments: '{"q":"x"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_123',
        output: 'done',
      },
    ])
  })

  test('preserves call IDs for parallel Codex tool uses and results', () => {
    const items = convertAnthropicMessagesToResponsesInput([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_a', name: 'read', input: { path: 'a' } },
          { type: 'tool_use', id: 'call_b', name: 'read', input: { path: 'b' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_a', content: 'A' },
          { type: 'tool_result', tool_use_id: 'call_b', content: 'B' },
        ],
      },
    ])

    expect(items.filter(item => item.type === 'function_call')).toEqual([
      {
        type: 'function_call',
        id: 'fc_a',
        call_id: 'call_a',
        name: 'read',
        arguments: '{"path":"a"}',
      },
      {
        type: 'function_call',
        id: 'fc_b',
        call_id: 'call_b',
        name: 'read',
        arguments: '{"path":"b"}',
      },
    ])
    expect(items.filter(item => item.type === 'function_call_output')).toEqual([
      { type: 'function_call_output', call_id: 'call_a', output: 'A' },
      { type: 'function_call_output', call_id: 'call_b', output: 'B' },
    ])
  })

  test('canonicalizes a truncated completed Codex tool response', () => {
    const message = convertCodexResponseToAnthropicMessage(
      {
        id: 'resp_1',
        status: 'completed',
        model: 'gpt-5.3-codex-spark',
        output: [
          {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'pin',
            arguments: '{"value":"ping"}',
          },
        ],
        usage: { input_tokens: 12, output_tokens: 4 },
      },
      'gpt-5.3-codex-spark',
      ['ping'],
    )

    expect(message.stop_reason).toBe('tool_use')
    expect(message.content).toEqual([
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'ping',
        input: { value: 'ping' },
      },
    ])
  })

  test('strips <think> tag block from completed Codex text responses', () => {
    const message = convertCodexResponseToAnthropicMessage(
      {
        id: 'resp_1',
        status: 'completed',
        model: 'gpt-5.4',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text:
                  '<think>user wants a greeting, respond briefly</think>Hey! How can I help you today?',
              },
            ],
          },
        ],
        usage: { input_tokens: 12, output_tokens: 4 },
      },
      'gpt-5.4',
    )

    expect(message.content).toEqual([
      {
        type: 'text',
        text: 'Hey! How can I help you today?',
      },
    ])
  })

  test('strips unterminated <think> tag at block boundary in Codex completed response', () => {
    const message = convertCodexResponseToAnthropicMessage(
      {
        id: 'resp_1',
        status: 'completed',
        model: 'gpt-5.4',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text:
                  'Here is the answer.\n<think>wait, let me reconsider the user request',
              },
            ],
          },
        ],
        usage: { input_tokens: 12, output_tokens: 4 },
      },
      'gpt-5.4',
    )

    expect(message.content).toEqual([
      {
        type: 'text',
        text: 'Here is the answer.',
      },
    ])
  })

  test('recovers Codex web search text and sources from sparse completed response', () => {
    const output = webSearchToolTest.makeOutputFromCodexWebSearchResponse(
      {
        output: [
          {
            type: 'web_search_call',
            sources: [
              {
                title: 'Verboo Code repo',
                url: 'https://github.com/example/verboo',
              },
            ],
          },
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'Verboo Code is available on GitHub.',
                sources: [
                  {
                    title: 'Docs',
                    url: 'https://docs.example.com/verboo',
                  },
                ],
              },
            ],
          },
        ],
      },
      'Verboo Code GitHub 2026',
      0.42,
    )

    expect(output.results).toEqual([
      'Verboo Code is available on GitHub.',
      {
        tool_use_id: 'codex-web-search',
        content: [
          {
            title: 'Verboo Code repo',
            url: 'https://github.com/example/verboo',
          },
          {
            title: 'Docs',
            url: 'https://docs.example.com/verboo',
          },
        ],
      },
    ])
  })

  test('falls back to a non-empty Codex web search result message', () => {
    const output = webSearchToolTest.makeOutputFromCodexWebSearchResponse(
      { output: [] },
      'Verboo Code GitHub 2026',
      0.11,
    )

    expect(output.results).toEqual(['No results found.'])
  })

  test('surfaces Codex web search failure reason with a message', () => {
    const output = webSearchToolTest.makeOutputFromCodexWebSearchResponse(
      {
        output: [
          {
            type: 'web_search_call',
            status: 'failed',
            error: { message: 'upstream search provider rate-limited' },
          },
        ],
      },
      'Verboo Code GitHub 2026',
      0.05,
    )

    expect(output.results).toEqual([
      'Web search failed: upstream search provider rate-limited',
    ])
  })

  test('surfaces Codex web search failure reason nested under action.error', () => {
    const output = webSearchToolTest.makeOutputFromCodexWebSearchResponse(
      {
        output: [
          {
            type: 'web_search_call',
            status: 'failed',
            action: { error: { message: 'query blocked' } },
          },
        ],
      },
      'Verboo Code GitHub 2026',
      0.05,
    )

    expect(output.results).toEqual(['Web search failed: query blocked'])
  })

  test('handles Codex web search failure with no reason attached', () => {
    const output = webSearchToolTest.makeOutputFromCodexWebSearchResponse(
      {
        output: [
          {
            type: 'web_search_call',
            status: 'failed',
          },
        ],
      },
      'Verboo Code GitHub 2026',
      0.05,
    )

    expect(output.results).toEqual(['Web search failed.'])
  })

  test('a failure item does not suppress sources from a later message item', () => {
    const output = webSearchToolTest.makeOutputFromCodexWebSearchResponse(
      {
        output: [
          {
            type: 'web_search_call',
            status: 'failed',
            error: { message: 'partial outage' },
          },
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'Partial results below.',
                sources: [
                  { title: 'Docs', url: 'https://docs.example.com/verboo' },
                ],
              },
            ],
          },
        ],
      },
      'Verboo Code GitHub 2026',
      0.05,
    )

    expect(output.results).toEqual([
      'Web search failed: partial outage',
      'Partial results below.',
      {
        tool_use_id: 'codex-web-search',
        content: [
          { title: 'Docs', url: 'https://docs.example.com/verboo' },
        ],
      },
    ])
  })

  test('translates Codex SSE text stream into Anthropic events', async () => {
    const responseText = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message","status":"in_progress","content":[],"role":"assistant"},"output_index":0,"sequence_number":0}',
      '',
      'event: response.content_part.added',
      'data: {"type":"response.content_part.added","content_index":0,"item_id":"msg_1","output_index":0,"part":{"type":"output_text","text":""},"sequence_number":1}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","content_index":0,"delta":"ok","item_id":"msg_1","output_index":0,"sequence_number":2}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message","status":"completed","content":[{"type":"output_text","text":"ok"}],"role":"assistant"},"output_index":0,"sequence_number":3}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5.4","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":2,"output_tokens":1}},"sequence_number":4}',
      '',
    ].join('\n')

    const eventTypes = await collectStreamEventTypes(responseText)

    expect(eventTypes).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
  })

  test('keeps Responses API parallel calls ordered while an earlier name is incomplete', async () => {
    const responseText = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"id":"fc_a","call_id":"call_a","type":"function_call","name":"Rea","arguments":""},"output_index":0}',
      '',
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"id":"fc_b","call_id":"call_b","type":"function_call","name":"Bash","arguments":""},"output_index":1}',
      '',
      'event: response.function_call_arguments.delta',
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc_a","delta":"{\\"path\\":\\"a\\"}"}',
      '',
      'event: response.function_call_arguments.delta',
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc_b","delta":"{\\"path\\":\\"b\\"}"}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"id":"fc_b","call_id":"call_b","type":"function_call","name":"Bash","arguments":"{\\"path\\":\\"b\\"}"},"output_index":1}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"id":"fc_a","call_id":"call_a","type":"function_call","name":"Rea","arguments":"{\\"path\\":\\"a\\"}"},"output_index":0}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_parallel","status":"completed","model":"gpt-5.4","output":[{"id":"fc_a","call_id":"call_a","type":"function_call","name":"Rea","arguments":"{\\"path\\":\\"a\\"}"},{"id":"fc_b","call_id":"call_b","type":"function_call","name":"Bash","arguments":"{\\"path\\":\\"b\\"}"}],"usage":{"input_tokens":2,"output_tokens":2}}}',
      '',
    ].join('\n')
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(responseText))
        controller.close()
      },
    })
    const toolUses: Array<{ id: string; name: string }> = []

    for await (const event of codexStreamToAnthropic(
      new Response(stream),
      'gpt-5.4',
      undefined,
      ['Read', 'Bash'],
    )) {
      const contentBlock = event.content_block as
        | { type?: string; id?: string; name?: string }
        | undefined
      if (
        event.type === 'content_block_start' &&
        contentBlock?.type === 'tool_use' &&
        typeof contentBlock.id === 'string' &&
        typeof contentBlock.name === 'string'
      ) {
        toolUses.push({
          id: contentBlock.id,
          name: contentBlock.name,
        })
      }
    }

    expect(toolUses).toEqual([
      { id: 'call_a', name: 'Read' },
      { id: 'call_b', name: 'Bash' },
    ])
  })

  test('recovers a truncated Responses API tool name before releasing buffered arguments', async () => {
    const responseText = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"id":"fc_read","call_id":"call_read","type":"function_call","name":"rea","arguments":""},"output_index":0}',
      '',
      'event: response.function_call_arguments.delta',
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc_read","delta":"{\\"file_path\\":\\"README.md\\"}"}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"id":"fc_read","call_id":"call_read","type":"function_call","name":"rea","arguments":"{\\"file_path\\":\\"README.md\\"}"},"output_index":0}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_read","status":"completed","model":"gpt-5.4","output":[{"id":"fc_read","call_id":"call_read","type":"function_call","name":"rea","arguments":"{\\"file_path\\":\\"README.md\\"}"}],"usage":{"input_tokens":2,"output_tokens":2}}}',
      '',
    ].join('\n')
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(responseText))
        controller.close()
      },
    })
    const events: AnthropicStreamEvent[] = []

    for await (const event of codexStreamToAnthropic(
      new Response(stream),
      'gpt-5.4',
      undefined,
      ['Read'],
    )) {
      events.push(event)
    }

    const toolStarts = events.filter(
      event =>
        event.type === 'content_block_start' &&
        event.content_block?.type === 'tool_use',
    )
    expect(toolStarts).toHaveLength(1)
    expect(toolStarts[0]?.content_block).toMatchObject({
      id: 'call_read',
      name: 'Read',
    })

    const input = events
      .filter(event => event.delta?.type === 'input_json_delta')
      .map(event => event.delta?.partial_json)
      .join('')
    expect(input).toBe('{"file_path":"README.md"}')
  })

  test('does not commit a tool when Responses SSE ends before response.completed', async () => {
    const responseText = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"id":"fc_read","call_id":"call_read","type":"function_call","name":"Read","arguments":""},"output_index":0}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"id":"fc_read","call_id":"call_read","type":"function_call","name":"Read","arguments":"{\\"file_path\\":\\"README.md\\"}"},"output_index":0}',
    ].join('\n')
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(responseText))
        controller.close()
      },
    })
    const events: AnthropicStreamEvent[] = []
    let thrown: unknown

    try {
      for await (const event of codexStreamToAnthropic(
        new Response(stream),
        'gpt-5.4',
        undefined,
        ['Read'],
      )) {
        events.push(event)
      }
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('without a terminal payload')
    expect(
      events.filter(event => event.content_block?.type === 'tool_use'),
    ).toHaveLength(0)
  })

  test('does not commit tools from response.incomplete', async () => {
    const responseText = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"id":"fc_read","call_id":"call_read","type":"function_call","name":"Read","arguments":""},"output_index":0}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"id":"fc_read","call_id":"call_read","type":"function_call","name":"Read","arguments":"{}"},"output_index":0}',
      '',
      'event: response.incomplete',
      'data: {"type":"response.incomplete","response":{"id":"resp_incomplete","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"id":"fc_read","call_id":"call_read","type":"function_call","name":"Read","arguments":"{}"}]}}',
    ].join('\n')
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(responseText))
        controller.close()
      },
    })
    const events: AnthropicStreamEvent[] = []

    for await (const event of codexStreamToAnthropic(
      new Response(stream),
      'gpt-5.4',
      undefined,
      ['Read'],
    )) {
      events.push(event)
    }

    expect(
      events.filter(event => event.content_block?.type === 'tool_use'),
    ).toHaveLength(0)
    expect(events.find(event => event.type === 'message_delta')?.delta).toMatchObject({
      stop_reason: 'max_tokens',
    })
    expect(events.at(-1)?.type).toBe('message_stop')
  })

  test('uses authoritative completed tools and adds final-only calls', async () => {
    const responseText = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"id":"fc_read","call_id":"call_read","type":"function_call","name":"Rea","arguments":""},"output_index":0}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"id":"fc_read","call_id":"call_read","type":"function_call","name":"Rea","arguments":"{\\"file_path\\":\\"stale.md\\"}"},"output_index":0}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_final","status":"completed","output":[{"id":"fc_read","call_id":"call_read","type":"function_call","name":"Read","arguments":"{\\"file_path\\":\\"README.md\\"}"},{"id":"fc_bash","call_id":"call_bash","type":"function_call","name":"Bash","arguments":"{\\"command\\":\\"pwd\\"}"}]}}',
    ].join('\n')
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(responseText))
        controller.close()
      },
    })
    const events: AnthropicStreamEvent[] = []

    for await (const event of codexStreamToAnthropic(
      new Response(stream),
      'gpt-5.4',
      undefined,
      ['Read', 'Bash'],
    )) {
      events.push(event)
    }

    const toolStarts = events
      .filter(event => event.content_block?.type === 'tool_use')
      .map(event => event.content_block)
    expect(toolStarts).toEqual([
      { type: 'tool_use', id: 'call_read', name: 'Read', input: {} },
      { type: 'tool_use', id: 'call_bash', name: 'Bash', input: {} },
    ])
    const inputs = events
      .filter(event => event.delta?.type === 'input_json_delta')
      .map(event => event.delta?.partial_json)
    expect(inputs).toEqual([
      '{"file_path":"README.md"}',
      '{"command":"pwd"}',
    ])
  })

  test('orders Codex tool blocks by authoritative final output instead of arrival', async () => {
    const responseText = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"id":"fc_one","call_id":"call_one","type":"function_call","name":"Bash","arguments":""},"output_index":1}',
      '',
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"id":"fc_zero","call_id":"call_zero","type":"function_call","name":"Read","arguments":""},"output_index":0}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_ordered","status":"completed","output":[{"id":"fc_zero","call_id":"call_zero","type":"function_call","name":"Read","arguments":"{\\"file_path\\":\\"README.md\\"}"},{"id":"fc_one","call_id":"call_one","type":"function_call","name":"Bash","arguments":"{\\"command\\":\\"pwd\\"}"}]}}',
      '',
      '',
    ].join('\n')
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(responseText))
        controller.close()
      },
    })

    const events: AnthropicStreamEvent[] = []
    for await (const event of codexStreamToAnthropic(
      new Response(stream),
      'gpt-5.4',
      undefined,
      ['Read', 'Bash'],
    )) {
      events.push(event)
    }
    const starts = events.filter(
      event =>
        event.type === 'content_block_start' &&
        event.content_block?.type === 'tool_use',
    )
    expect(starts.map(event => [event.index, event.content_block?.id])).toEqual([
      [0, 'call_zero'],
      [1, 'call_one'],
    ])
    const lifecycle = events
      .filter(event =>
        event.type === 'content_block_start' ||
        event.type === 'content_block_delta' ||
        event.type === 'content_block_stop',
      )
      .map(event => `${event.type}:${String(event.index)}`)
    expect(lifecycle).toEqual([
      'content_block_start:0',
      'content_block_delta:0',
      'content_block_stop:0',
      'content_block_start:1',
      'content_block_delta:1',
      'content_block_stop:1',
    ])
  })

  test('rejects duplicate completed tool IDs before committing a block', async () => {
    const responseText = [
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_duplicate_calls","status":"completed","output":[{"type":"function_call","id":"fc_read","call_id":"same_call","name":"Read","arguments":"{}"},{"type":"function_call","id":"fc_bash","call_id":"same_call","name":"Bash","arguments":"{}"}]}}',
    ].join('\n')
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(responseText))
        controller.close()
      },
    })
    const response = new Response(stream)

    const events: AnthropicStreamEvent[] = []
    let thrown: unknown
    try {
      for await (const event of codexStreamToAnthropic(
        response,
        'gpt-test',
        undefined,
        ['Read', 'Bash'],
      )) {
        events.push(event)
      }
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect(String((thrown as Error).message)).toContain('no tool was committed')
    expect(
      events.filter(event => event.type === 'content_block_start'),
    ).toHaveLength(0)
  })

  test('completed-response conversion suppresses tools for incomplete status', () => {
    const message = convertCodexResponseToAnthropicMessage(
      {
        id: 'resp_incomplete',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [
          {
            id: 'fc_read',
            call_id: 'call_read',
            type: 'function_call',
            name: 'Read',
            arguments: '{}',
          },
        ],
      },
      'gpt-5.4',
      ['Read'],
    ) as { content: Array<{ type?: string }>; stop_reason: string }

    expect(message.content.filter(item => item.type === 'tool_use')).toHaveLength(0)
    expect(message.stop_reason).toBe('max_tokens')
  })

  test.each([
    [
      'missing',
      {
        id: 'resp_missing_status',
        output: [
          {
            id: 'fc_read',
            call_id: 'call_read',
            type: 'function_call',
            name: 'Read',
            arguments: '{}',
          },
        ],
      },
      /omitted its terminal status/,
    ],
    [
      'failed',
      {
        id: 'resp_failed',
        status: 'failed',
        error: { message: 'provider failed' },
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'partial' }],
          },
        ],
      },
      /response failed: provider failed/,
    ],
  ])('completed-response conversion rejects %s terminal status', (
    _case,
    response,
    errorPattern,
  ) => {
    expect(() =>
      convertCodexResponseToAnthropicMessage(
        response,
        'gpt-5.4',
        ['Read'],
      ),
    ).toThrow(errorPattern)
  })

  test('completed-response conversion rejects duplicate or malformed tools', () => {
    const baseCall = {
      type: 'function_call',
      id: 'fc_read',
      call_id: 'same_call',
      name: 'Read',
      arguments: '{}',
    }
    expect(() =>
      convertCodexResponseToAnthropicMessage(
        { status: 'completed', output: [baseCall, { ...baseCall, id: 'fc_2' }] },
        'gpt-5.4',
        ['Read'],
      ),
    ).toThrow('reused a tool call ID')
    expect(() =>
      convertCodexResponseToAnthropicMessage(
        {
          status: 'completed',
          output: [{ ...baseCall, call_id: 'call_invalid', arguments: '{"x":' }],
        },
        'gpt-5.4',
        ['Read'],
      ),
    ).toThrow('invalid tool arguments')
  })

  test('strips <think> tag block from Codex SSE text stream', async () => {
    const responseText = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message","status":"in_progress","content":[],"role":"assistant"},"output_index":0,"sequence_number":0}',
      '',
      'event: response.content_part.added',
      'data: {"type":"response.content_part.added","content_index":0,"item_id":"msg_1","output_index":0,"part":{"type":"output_text","text":""},"sequence_number":1}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","content_index":0,"delta":"<think>user wants a greeting, respond briefly</think>Hey! How can I help you today?","item_id":"msg_1","output_index":0,"sequence_number":2}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message","status":"completed","content":[{"type":"output_text","text":"<think>user wants a greeting, respond briefly</think>Hey! How can I help you today?"}],"role":"assistant"},"output_index":0,"sequence_number":3}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5.4","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"<think>user wants a greeting, respond briefly</think>Hey! How can I help you today?"}]}],"usage":{"input_tokens":2,"output_tokens":1}},"sequence_number":4}',
      '',
    ].join('\n')

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(responseText))
        controller.close()
      },
    })

    const textDeltas: string[] = []
    for await (const event of codexStreamToAnthropic(
      new Response(stream),
      'gpt-5.4',
    )) {
      const delta = (event as { delta?: { type?: string; text?: string } }).delta
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        textDeltas.push(delta.text)
      }
    }

    expect(textDeltas.join('')).toBe('Hey! How can I help you today?')
  })

  test('preserves prose without tags (no phrase-based false positive)', async () => {
    // Regression test: older phrase-based sanitizer would incorrectly strip text
    // starting with "I should" or "The user". The tag-based approach leaves it alone.
    const responseText = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message","status":"in_progress","content":[],"role":"assistant"},"output_index":0,"sequence_number":0}',
      '',
      'event: response.content_part.added',
      'data: {"type":"response.content_part.added","content_index":0,"item_id":"msg_1","output_index":0,"part":{"type":"output_text","text":""},"sequence_number":1}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","content_index":0,"delta":"I should note that the user role requires a briefly concise friendly response format.","item_id":"msg_1","output_index":0,"sequence_number":2}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message","status":"completed","content":[{"type":"output_text","text":"I should note that the user role requires a briefly concise friendly response format."}],"role":"assistant"},"output_index":0,"sequence_number":3}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5.4","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"I should note that the user role requires a briefly concise friendly response format."}]}],"usage":{"input_tokens":2,"output_tokens":1}},"sequence_number":4}',
      '',
    ].join('\n')

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(responseText))
        controller.close()
      },
    })

    const textDeltas: string[] = []
    for await (const event of codexStreamToAnthropic(
      new Response(stream),
      'gpt-5.4',
    )) {
      const delta = (event as { delta?: { type?: string; text?: string } }).delta
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        textDeltas.push(delta.text)
      }
    }

    expect(textDeltas.join('')).toBe(
      'I should note that the user role requires a briefly concise friendly response format.',
    )
  })

  test('balances text blocks when the Codex reader rejects', async () => {
    const encoder = new TextEncoder()
    let read = false
    const stream = new ReadableStream({
      pull(controller) {
        if (!read) {
          read = true
          controller.enqueue(
            encoder.encode(
              [
                'event: response.output_text.delta',
                'data: {"type":"response.output_text.delta","delta":"visible"}',
                '',
                '',
              ].join('\n'),
            ),
          )
          return
        }
        controller.error(new Error('wire broke'))
      },
    })

    const events: AnthropicStreamEvent[] = []
    let thrown: unknown
    try {
      for await (const event of codexStreamToAnthropic(
        new Response(stream),
        'gpt-5.4',
      )) {
        events.push(event)
      }
    } catch (error) {
      thrown = error
    }

    expect((thrown as Error).message).toContain('wire broke')
    expect(events.filter(event => event.type === 'content_block_start')).toHaveLength(1)
    expect(events.filter(event => event.type === 'content_block_stop')).toHaveLength(1)
    expect(events.filter(event => event.type === 'message_stop')).toHaveLength(0)
  })

  test('cancels a Codex response body when a terminal event arrives before transport EOF', async () => {
    const terminalPayload = [
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_terminal","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}]}}',
      '',
      '',
    ].join('\n')
    const makeOpenResponse = (onCancel: () => void) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(terminalPayload))
          },
          cancel() {
            onCancel()
          },
        }),
      )

    let streamCancelCount = 0
    const events: AnthropicStreamEvent[] = []
    for await (const event of codexStreamToAnthropic(
      makeOpenResponse(() => streamCancelCount++),
      'gpt-5.4',
    )) {
      events.push(event)
    }
    expect(events.at(-1)?.type).toBe('message_stop')
    expect(streamCancelCount).toBe(1)

    let collectCancelCount = 0
    const collected = await collectCodexCompletedResponse(
      makeOpenResponse(() => collectCancelCount++),
    )
    expect(collected.status).toBe('completed')
    expect(collectCancelCount).toBe(1)
  })

  test('balances text blocks when Codex SSE contains invalid JSON', async () => {
    const responseText = [
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"visible"}',
      '',
      'event: response.output_text.delta',
      'data: {BROKEN JSON}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_lost","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"visible-lost"}]}]}}',
      '',
      '',
    ].join('\n')
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(responseText))
        controller.close()
      },
    })

    const events: AnthropicStreamEvent[] = []
    let thrown: unknown
    try {
      for await (const event of codexStreamToAnthropic(
        new Response(stream),
        'gpt-5.4',
      )) {
        events.push(event)
      }
    } catch (error) {
      thrown = error
    }

    expect((thrown as Error).message).toContain('invalid JSON')
    expect(events.filter(event => event.type === 'content_block_start')).toHaveLength(1)
    expect(events.filter(event => event.type === 'content_block_stop')).toHaveLength(1)
    expect(events.filter(event => event.type === 'message_stop')).toHaveLength(0)
  })

  test('emits text present only in the authoritative completed payload', async () => {
    const responseText = [
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_final_text","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"final-only"}]}]}}',
      '',
      '',
    ].join('\n')
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(responseText))
        controller.close()
      },
    })

    const events: AnthropicStreamEvent[] = []
    for await (const event of codexStreamToAnthropic(
      new Response(stream),
      'gpt-5.4',
    )) {
      events.push(event)
    }
    const text = events
      .filter(event => event.delta?.type === 'text_delta')
      .map(event => event.delta?.text ?? '')
      .join('')
    expect(text).toBe('final-only')
    expect(events.filter(event => event.type === 'content_block_start')).toHaveLength(1)
    expect(events.filter(event => event.type === 'content_block_stop')).toHaveLength(1)
  })

  test('rejects final-only text after a reserved tool block before emitting either block', async () => {
    const responseText = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"id":"fc_read","call_id":"call_read","type":"function_call","name":"Read","arguments":""},"output_index":0}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_out_of_order","status":"completed","output":[{"id":"fc_read","call_id":"call_read","type":"function_call","name":"Read","arguments":"{}"},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"final-only"}]}]}}',
      '',
      '',
    ].join('\n')
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(responseText))
        controller.close()
      },
    })

    const events: AnthropicStreamEvent[] = []
    let thrown: unknown
    try {
      for await (const event of codexStreamToAnthropic(
        new Response(stream),
        'gpt-5.4',
        undefined,
        ['Read'],
      )) {
        events.push(event)
      }
    } catch (error) {
      thrown = error
    }

    expect((thrown as Error).message).toContain('reserved tool block')
    expect(
      events.filter(event => event.type === 'content_block_start'),
    ).toHaveLength(0)
    expect(events.filter(event => event.type === 'message_stop')).toHaveLength(0)
  })

  test('rejects streamed text after a reserved tool block before emitting either block', async () => {
    const responseText = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"id":"fc_read","call_id":"call_read","type":"function_call","name":"Read","arguments":""},"output_index":0}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","item_id":"msg_after_tool","output_index":1,"content_index":0,"delta":"visible"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_out_of_order_stream","status":"completed","output":[{"id":"fc_read","call_id":"call_read","type":"function_call","name":"Read","arguments":"{}"},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"visible"}]}]}}',
      '',
      '',
    ].join('\n')
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(responseText))
        controller.close()
      },
    })

    const events: AnthropicStreamEvent[] = []
    let thrown: unknown
    try {
      for await (const event of codexStreamToAnthropic(
        new Response(stream),
        'gpt-5.4',
        undefined,
        ['Read'],
      )) {
        events.push(event)
      }
    } catch (error) {
      thrown = error
    }

    expect((thrown as Error).message).toContain('text after a reserved tool block')
    expect(
      events.filter(event => event.type === 'content_block_start'),
    ).toHaveLength(0)
    expect(events.filter(event => event.type === 'message_stop')).toHaveLength(0)
  })

  test('rejects streamed text absent from the authoritative final output before tools start', async () => {
    const responseText = [
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"stale"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_stale","status":"completed","output":[{"id":"fc_read","call_id":"call_read","type":"function_call","name":"Read","arguments":"{}"}]}}',
      '',
      '',
    ].join('\n')
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(responseText))
        controller.close()
      },
    })

    const events: AnthropicStreamEvent[] = []
    let thrown: unknown
    try {
      for await (const event of codexStreamToAnthropic(
        new Response(stream),
        'gpt-5.4',
        undefined,
        ['Read'],
      )) {
        events.push(event)
      }
    } catch (error) {
      thrown = error
    }
    expect((thrown as Error).message).toContain('contradicted streamed text')
    expect(
      events.filter(
        event =>
          event.type === 'content_block_start' &&
          event.content_block?.type === 'tool_use',
      ),
    ).toHaveLength(0)
    expect(events.filter(event => event.type === 'content_block_start')).toHaveLength(1)
    expect(events.filter(event => event.type === 'content_block_stop')).toHaveLength(1)
  })

  test('rejects contradictory incomplete terminal status without committing tools', async () => {
    const responseText = [
      'event: response.incomplete',
      'data: {"type":"response.incomplete","response":{"id":"resp_bad_status","status":"completed","output":[{"id":"fc_read","call_id":"call_read","type":"function_call","name":"Read","arguments":"{}"}]}}',
      '',
      '',
    ].join('\n')
    const makeResponse = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(responseText))
            controller.close()
          },
        }),
      )

    const events: AnthropicStreamEvent[] = []
    let streamError: unknown
    try {
      for await (const event of codexStreamToAnthropic(
        makeResponse(),
        'gpt-5.4',
        undefined,
        ['Read'],
      )) {
        events.push(event)
      }
    } catch (error) {
      streamError = error
    }
    expect((streamError as Error).message).toContain('contradictory status')
    expect(
      events.filter(event => event.content_block?.type === 'tool_use'),
    ).toHaveLength(0)

    let collectedError: unknown
    try {
      await collectCodexCompletedResponse(makeResponse())
    } catch (error) {
      collectedError = error
    }
    expect((collectedError as Error).message).toContain('contradictory status')
  })

  test.each([
    ['missing response object', { type: 'response.completed' }, /response object/],
    ['null response object', { type: 'response.completed', response: null }, /response object/],
    ['scalar response object', { type: 'response.completed', response: 'bad' }, /response object/],
    [
      'missing terminal status',
      { type: 'response.completed', response: { id: 'resp_bad', output: [] } },
      /missing or contradictory status/,
    ],
    [
      'missing response ID',
      { type: 'response.completed', response: { status: 'completed', output: [] } },
      /response ID/,
    ],
    [
      'missing output array',
      { type: 'response.completed', response: { id: 'resp_bad', status: 'completed' } },
      /output array/,
    ],
  ])('rejects completed terminal payload with %s in stream and collection', async (
    _case,
    terminalPayload,
    errorPattern,
  ) => {
    const responseText = [
      'event: response.completed',
      `data: ${JSON.stringify(terminalPayload)}`,
      '',
      '',
    ].join('\n')
    const makeResponse = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(responseText))
            controller.close()
          },
        }),
      )

    const events: AnthropicStreamEvent[] = []
    let streamError: unknown
    try {
      for await (const event of codexStreamToAnthropic(
        makeResponse(),
        'gpt-5.4',
      )) {
        events.push(event)
      }
    } catch (error) {
      streamError = error
    }
    expect((streamError as Error).message).toMatch(errorPattern)
    expect(events.filter(event => event.type === 'content_block_start')).toHaveLength(0)
    expect(events.filter(event => event.type === 'message_stop')).toHaveLength(0)

    let collectedError: unknown
    try {
      await collectCodexCompletedResponse(makeResponse())
    } catch (error) {
      collectedError = error
    }
    expect((collectedError as Error).message).toMatch(errorPattern)
  })

  test('rejects missing final Codex tool IDs in streaming and completed conversion', async () => {
    const finalTool = {
      type: 'function_call',
      name: 'Read',
      arguments: '{}',
    }
    const responseText = [
      'event: response.completed',
      `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_missing_id', status: 'completed', output: [finalTool] } })}`,
      '',
      '',
    ].join('\n')
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(responseText))
        controller.close()
      },
    })

    const events: AnthropicStreamEvent[] = []
    let streamError: unknown
    try {
      for await (const event of codexStreamToAnthropic(
        new Response(stream),
        'gpt-5.4',
        undefined,
        ['Read'],
      )) {
        events.push(event)
      }
    } catch (error) {
      streamError = error
    }
    expect((streamError as Error).message).toContain('omitted its tool call ID')
    expect(
      events.filter(event => event.content_block?.type === 'tool_use'),
    ).toHaveLength(0)
    expect(() =>
      convertCodexResponseToAnthropicMessage(
        { id: 'resp_missing_id', status: 'completed', output: [finalTool] },
        'gpt-5.4',
        ['Read'],
      ),
    ).toThrow(/omitted its tool call ID/)
  })

  test('caps Codex tool argument buffering before tool start', async () => {
    process.env.VERBOO_MAX_BUFFERED_TOOL_ARGUMENT_CHARS = '32'
    const responseText = [
      'event: response.output_item.added',
      `data: ${JSON.stringify({ type: 'response.output_item.added', item: { id: 'fc_large', call_id: 'call_large', type: 'function_call', name: 'Read', arguments: '' } })}`,
      '',
      'event: response.function_call_arguments.delta',
      `data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'fc_large', delta: 'x'.repeat(33) })}`,
      '',
      '',
    ].join('\n')
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(responseText))
        controller.close()
      },
    })

    const events: AnthropicStreamEvent[] = []
    let thrown: unknown
    try {
      for await (const event of codexStreamToAnthropic(
        new Response(stream),
        'gpt-5.4',
        undefined,
        ['Read'],
      )) {
        events.push(event)
      }
    } catch (error) {
      thrown = error
    }
    expect((thrown as Error).message).toContain('safety limit')
    expect(
      events.filter(event => event.content_block?.type === 'tool_use'),
    ).toHaveLength(0)
  })
})

describe('convertSystemPrompt', () => {
  test('strips Anthropic attribution header block from text-block array (#607)', () => {
    const result = convertSystemPrompt([
      {
        type: 'text',
        text:
          'x-anthropic-billing-header: cc_version=0.8.0.abc123; ' +
          'cc_entrypoint=cli;',
      },
      { type: 'text', text: 'You are Claude Code.' },
      { type: 'text', text: 'Project context: bun + react.' },
    ])

    expect(result).not.toContain('x-anthropic-billing-header')
    expect(result).not.toContain('cc_version=')
    expect(result).toContain('You are Claude Code.')
    expect(result).toContain('Project context: bun + react.')
  })

  test('returns empty string when only the attribution block is present', () => {
    const result = convertSystemPrompt([
      {
        type: 'text',
        text: 'x-anthropic-billing-header: cc_version=0.8.0.abc;',
      },
    ])

    expect(result).toBe('')
  })

  test('passes plain string system prompts through untouched', () => {
    expect(convertSystemPrompt('You are Claude Code.')).toBe(
      'You are Claude Code.',
    )
  })
})
