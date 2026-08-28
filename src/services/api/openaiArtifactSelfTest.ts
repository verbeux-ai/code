import { createOpenAIShimClient } from './openaiShim.js'
import { TOOL_NAME_PREFIX_RECOVERY_ALLOWED } from '../../Tool.js'

type ArtifactShimClient = {
  beta: {
    messages: {
      create: (
        params: Record<string, unknown>,
      ) => Promise<unknown> & {
        withResponse: () => Promise<{
          data: AsyncIterable<Record<string, unknown>>
        }>
      }
    }
  }
}

const MARKER = 'Verboo: ação, ç, 你好, 👩🏽‍💻, e\u0301'

function event(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function oneByteResponse(source: string | Uint8Array): Response {
  const bytes =
    typeof source === 'string' ? new TextEncoder().encode(source) : source
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
        controller.close()
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  )
}

async function collectStream(
  response: Response,
  params: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  globalThis.fetch = (async () => response) as unknown as typeof fetch
  const client = createOpenAIShimClient({}) as ArtifactShimClient
  const result = await client.beta.messages.create(params).withResponse()
  const events: Array<Record<string, unknown>> = []
  for await (const item of result.data) events.push(item)
  return events
}

function baseParams(): Record<string, unknown> {
  return {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'protocol self-test' }],
    max_tokens: 64,
    stream: true,
  }
}

async function verifySplitToolName(): Promise<void> {
  const stream = [
    event({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_artifact_read',
                type: 'function',
                function: {
                  name: 'rea',
                  arguments: JSON.stringify({ marker: MARKER }),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    event({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, function: { name: 'd' } },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    event({
      choices: [
        { index: 0, delta: {}, finish_reason: 'tool_calls' },
      ],
    }),
    'data: [DONE]\n\n',
  ].join('')
  const events = await collectStream(oneByteResponse(stream), {
    ...baseParams(),
    tools: [
      {
        name: 'read',
        description: 'Artifact protocol self-test.',
        input_schema: {
          type: 'object',
          properties: { marker: { type: 'string' } },
          required: ['marker'],
        },
      },
    ],
  })
  const start = events.find(
    item =>
      item.type === 'content_block_start' &&
      (item as { content_block?: { type?: unknown } }).content_block?.type ===
        'tool_use',
  ) as { content_block?: { name?: unknown } } | undefined
  const input = events
    .filter(
      item =>
        item.type === 'content_block_delta' &&
        (item as { delta?: { type?: unknown } }).delta?.type ===
          'input_json_delta',
    )
    .map(
      item =>
        (item as { delta?: { partial_json?: unknown } }).delta?.partial_json ??
        '',
    )
    .join('')
  if (start?.content_block?.name !== 'read') {
    throw new Error('packaged parser did not reconstruct rea+d as read')
  }
  if ((JSON.parse(input) as { marker?: unknown }).marker !== MARKER) {
    throw new Error('packaged parser corrupted Unicode tool arguments')
  }
  if (!events.some(item => item.type === 'message_stop')) {
    throw new Error('packaged parser omitted the terminal message event')
  }
}

async function verifyTerminalPrefixRecovery(): Promise<void> {
  const stream = [
    event({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_artifact_prefix',
                type: 'function',
                function: { name: 'rea', arguments: '{}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    event({
      choices: [
        { index: 0, delta: {}, finish_reason: 'tool_calls' },
      ],
    }),
    'data: [DONE]\n\n',
  ].join('')
  const events = await collectStream(oneByteResponse(stream), {
    ...baseParams(),
    tools: [
      {
        name: 'read',
        description: 'Artifact protocol self-test.',
        [TOOL_NAME_PREFIX_RECOVERY_ALLOWED]: true,
        input_schema: { type: 'object', properties: {} },
      },
    ],
  })
  const start = events.find(
    item =>
      item.type === 'content_block_start' &&
      (item as { content_block?: { type?: unknown } }).content_block?.type ===
        'tool_use',
  ) as { content_block?: { name?: unknown } } | undefined
  if (start?.content_block?.name !== 'read') {
    throw new Error('packaged parser did not safely recover terminal rea')
  }
}

async function verifyUnprefixedMcpExactOnly(): Promise<void> {
  const toolStream = (name: string, id: string) =>
    [
      event({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id,
                  type: 'function',
                  function: { name, arguments: '{}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      event({
        choices: [
          { index: 0, delta: {}, finish_reason: 'tool_calls' },
        ],
      }),
      'data: [DONE]\n\n',
    ].join('')
  // An unprefixed MCP schema deliberately has no internal-recovery marker.
  const params = {
    ...baseParams(),
    tools: [
      {
        name: 'send',
        description: 'Unprefixed MCP protocol self-test.',
        input_schema: { type: 'object', properties: {} },
      },
    ],
  }

  let rejectedTruncatedName = false
  try {
    await collectStream(
      oneByteResponse(toolStream('sen', 'call_mcp_truncated')),
      params,
    )
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes('incomplete or ambiguous tool call')
    ) {
      throw error
    }
    rejectedTruncatedName = true
  }
  if (!rejectedTruncatedName) {
    throw new Error('packaged parser recovered a truncated unprefixed MCP name')
  }
  const exactEvents = await collectStream(
    oneByteResponse(toolStream('send', 'call_mcp_exact')),
    params,
  )
  const exactStart = exactEvents.find(
    item =>
      item.type === 'content_block_start' &&
      (item as { content_block?: { type?: unknown } }).content_block?.type ===
        'tool_use',
  ) as { content_block?: { name?: unknown } } | undefined
  if (exactStart?.content_block?.name !== 'send') {
    throw new Error('packaged parser rejected an exact unprefixed MCP tool name')
  }
}

async function verifyVisibleUnicode(): Promise<void> {
  const midpoint = Math.floor(MARKER.length / 2)
  const stream = [
    event({
      choices: [
        {
          index: 0,
          delta: { content: MARKER.slice(0, midpoint) },
          finish_reason: null,
        },
      ],
    }),
    event({
      choices: [
        {
          index: 0,
          delta: { content: MARKER.slice(midpoint) },
          finish_reason: null,
        },
      ],
    }),
    event({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }),
    'data: [DONE]\n\n',
  ].join('')
  const events = await collectStream(oneByteResponse(stream), baseParams())
  const visible = events
    .filter(
      item =>
        item.type === 'content_block_delta' &&
        (item as { delta?: { type?: unknown } }).delta?.type === 'text_delta',
    )
    .map(item => (item as { delta?: { text?: unknown } }).delta?.text ?? '')
    .join('')
  if (visible !== MARKER) {
    throw new Error('packaged parser corrupted visible Unicode')
  }
}

async function expectStreamRejection(
  response: Response,
  expectedMessage: string,
): Promise<void> {
  try {
    await collectStream(response, baseParams())
  } catch (error) {
    if (error instanceof Error && error.message.includes(expectedMessage)) {
      return
    }
    throw error
  }
  throw new Error(`packaged parser accepted ${expectedMessage}`)
}

async function verifyPostTerminalRejection(): Promise<void> {
  const stream = [
    event({
      choices: [
        { index: 0, delta: { content: 'ok' }, finish_reason: 'stop' },
      ],
    }),
    'data: [DONE]\n\n',
    event({
      choices: [
        { index: 0, delta: { content: 'late' }, finish_reason: null },
      ],
    }),
  ].join('')
  await expectStreamRejection(oneByteResponse(stream), 'after [DONE]')
}

async function verifyInvalidUTF8Rejection(): Promise<void> {
  const prefix = new TextEncoder().encode(
    'data: {"choices":[{"index":0,"delta":{"content":"',
  )
  const bytes = new Uint8Array(prefix.length + 2)
  bytes.set(prefix)
  bytes.set([0xc3, 0x28], prefix.length)
  await expectStreamRejection(oneByteResponse(bytes), 'invalid UTF-8')
}

async function verifyInvalidUnicodeScalarRejection(): Promise<void> {
  const invalidArguments = JSON.stringify({
    marker: String.fromCharCode(0xd800),
  })
  const stream = [
    event({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_invalid_unicode',
                type: 'function',
                function: { name: 'read', arguments: invalidArguments },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    event({
      choices: [
        { index: 0, delta: {}, finish_reason: 'tool_calls' },
      ],
    }),
    'data: [DONE]\n\n',
  ].join('')
  globalThis.fetch = (async () => oneByteResponse(stream)) as unknown as typeof fetch
  const client = createOpenAIShimClient({}) as ArtifactShimClient
  const result = await client.beta.messages
    .create({
      ...baseParams(),
      tools: [
        {
          name: 'read',
          description: 'Artifact protocol self-test.',
          input_schema: { type: 'object', properties: {} },
        },
      ],
    })
    .withResponse()
  try {
    for await (const _item of result.data) {
      // Drain until terminal validation rejects the nested surrogate.
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('incomplete or ambiguous tool call')
    ) {
      return
    }
    throw error
  }
  throw new Error('packaged parser accepted an invalid Unicode scalar')
}

export async function runOpenAIArtifactProtocolSelfTest(): Promise<{
  schemaVersion: 1
  ok: true
  marker: string
  checks: string[]
}> {
  const originalFetch = globalThis.fetch
  const originalEnvironment = {
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
  }
  process.env.OPENAI_BASE_URL = 'http://artifact-self-test.invalid/v1'
  process.env.OPENAI_API_KEY = 'artifact-self-test'
  process.env.OPENAI_MODEL = 'gpt-4o'
  process.env.CLAUDE_CODE_USE_OPENAI = 'true'
  try {
    await verifySplitToolName()
    await verifyTerminalPrefixRecovery()
    await verifyUnprefixedMcpExactOnly()
    await verifyVisibleUnicode()
    await verifyPostTerminalRejection()
    await verifyInvalidUTF8Rejection()
    await verifyInvalidUnicodeScalarRejection()
    return {
      schemaVersion: 1,
      ok: true,
      marker: MARKER,
      checks: [
        'split_tool_name',
        'terminal_tool_prefix',
        'unprefixed_mcp_exact_only',
        'visible_unicode',
        'post_terminal',
        'strict_utf8',
        'invalid_unicode_scalar',
      ],
    }
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}
