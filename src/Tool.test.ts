import { describe, expect, test } from 'bun:test'

import { findToolByNameOrUniquePrefix, type Tools } from './Tool.js'

const tools = [
  { name: 'Read' },
  { name: 'Bash' },
  { name: 'Grep' },
] as Tools

describe('findToolByNameOrUniquePrefix', () => {
  test('recovers an unambiguous provider-truncated built-in tool name', () => {
    expect(findToolByNameOrUniquePrefix(tools, 'Rea')?.name).toBe('Read')
  })

  test('does not guess short, ambiguous, or MCP tool names', () => {
    expect(findToolByNameOrUniquePrefix(tools, 'R')).toBeUndefined()
    expect(
      findToolByNameOrUniquePrefix(
        [{ name: 'Read' }, { name: 'Ready' }] as Tools,
        'Rea',
      ),
    ).toBeUndefined()
    expect(
      findToolByNameOrUniquePrefix(
        [{ name: 'mcp__files__read' }] as Tools,
        'mcp__files__rea',
      ),
    ).toBeUndefined()
  })
})
