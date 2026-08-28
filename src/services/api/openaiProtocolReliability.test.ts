import { expect, test } from 'bun:test'
import {
  resolveStreamedToolName,
  runOpenAIProtocolReliabilitySelfTest,
} from './openaiProtocolReliability.js'

test('protocol self-test validates UTF-8 and tool fragment invariants', () => {
  expect(runOpenAIProtocolReliabilitySelfTest()).toEqual({
    ok: true,
    detail: 'Strict UTF-8 and exact/terminal-prefix tool checks passed.',
  })
})

test('cumulative and delta tool names resolve without false prefix recovery', () => {
  expect(resolveStreamedToolName(['ReadFile'], ['Read', 'File'], ['ReadFile'])).toEqual({
    name: 'ReadFile',
    ambiguous: false,
    recoveredUniquePrefix: false,
  })
  expect(resolveStreamedToolName(['ReadFile'], ['Read', 'ReadFile'], ['ReadFile'])).toEqual({
    name: 'ReadFile',
    ambiguous: false,
    recoveredUniquePrefix: false,
  })
  expect(resolveStreamedToolName(['ReadFile'], ['Rea'], ['ReadFile'])).toEqual({
    name: 'Rea',
    ambiguous: true,
    recoveredUniquePrefix: false,
  })
})

test('unprefixed MCP tools require an exact case-sensitive streamed name', () => {
  expect(resolveStreamedToolName(['send'], ['sen'], [])).toEqual({
    name: 'sen',
    ambiguous: true,
    recoveredUniquePrefix: false,
  })
  expect(resolveStreamedToolName(['send'], ['SEND'], [])).toEqual({
    name: 'SEND',
    ambiguous: true,
    recoveredUniquePrefix: false,
  })
  expect(resolveStreamedToolName(['send'], ['send'], [])).toEqual({
    name: 'send',
    ambiguous: false,
    recoveredUniquePrefix: false,
  })
})
