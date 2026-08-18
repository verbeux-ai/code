import { describe, expect, test } from 'bun:test'

import { findToolByNameOrUniquePrefix, type Tools } from './Tool.js'
import { getAllBaseTools } from './tools.js'

const tools = [
  { name: 'Read' },
  { name: 'Bash' },
  { name: 'Grep' },
] as Tools

describe('findToolByNameOrUniquePrefix', () => {
  test('recovers an unambiguous provider-truncated built-in tool name', () => {
    expect(findToolByNameOrUniquePrefix(tools, 'Rea')?.name).toBe('Read')
  })

  test('prefers a unique one-character completion over longer deferred tools', () => {
    expect(
      findToolByNameOrUniquePrefix(
        [{ name: 'Read' }, { name: 'ReadMcpResourceTool' }] as Tools,
        'Rea',
      )?.name,
    ).toBe('Read')
  })

  test('does not guess short, genuinely ambiguous, or MCP tool names', () => {
    expect(findToolByNameOrUniquePrefix(tools, 'R')).toBeUndefined()
    expect(
      findToolByNameOrUniquePrefix(
        [{ name: 'Read' }, { name: 'Real' }] as Tools,
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

  test('recovers a missing final character for every registered built-in tool', () => {
    const baseTools = getAllBaseTools()

    for (const tool of baseTools) {
      if (tool.name.length < 4 || tool.name.startsWith('mcp__')) continue
      const truncatedName = tool.name.slice(0, -1)
      expect(
        findToolByNameOrUniquePrefix(baseTools, truncatedName)?.name,
      ).toBe(tool.name)
    }
  })
})
