import { expect, test } from 'bun:test'

import type { Tools } from '../Tool.js'
import type { Message } from '../types/message.js'
import {
  normalizeContentFromAPI,
  normalizeMessagesForAPI,
} from './messages.js'

function toolNames(...names: string[]): Tools {
  return names.map(name => ({ name })) as unknown as Tools
}

function toolUse(name: string) {
  return [
    {
      type: 'tool_use' as const,
      id: 'call_1',
      name,
      input: '{"file_path":"README.md"}',
    },
  ]
}

test('canonicalizes an unambiguous terminal tool-name prefix', () => {
  const [normalized] = normalizeContentFromAPI(
    toolUse('Rea'),
    toolNames('Read', 'ReadMcpResourceTool'),
  )

  expect(normalized).toMatchObject({
    type: 'tool_use',
    name: 'Read',
    input: { file_path: 'README.md' },
  })
})

test('does not canonicalize ambiguous, aliased, or MCP tool names', () => {
  const [ambiguous] = normalizeContentFromAPI(
    toolUse('Rea'),
    toolNames('Read', 'Real'),
  )
  const [aliased] = normalizeContentFromAPI(
    toolUse('Rea'),
    [{ name: 'Reader', aliases: ['Rea'] }] as unknown as Tools,
  )
  const [mcp] = normalizeContentFromAPI(
    toolUse('mcp__files__rea'),
    toolNames('mcp__files__read'),
  )

  expect(ambiguous).toMatchObject({ name: 'Rea' })
  expect(aliased).toMatchObject({ name: 'Rea' })
  expect(mcp).toMatchObject({ name: 'mcp__files__rea' })
})

test('canonicalizes truncated tool names when replaying an existing transcript', () => {
  const [normalized] = normalizeMessagesForAPI(
    [
      {
        type: 'assistant',
        uuid: 'message_1',
        timestamp: '2026-08-18T00:00:00.000Z',
        message: {
          id: 'message_1',
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'Rea',
              input: { file_path: 'README.md' },
            },
          ],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
          },
        },
      },
    ] as unknown as Message[],
    toolNames('Read', 'ReadMcpResourceTool'),
  )

  expect(normalized?.message.content[0]).toMatchObject({
    type: 'tool_use',
    name: 'Read',
  })
})
