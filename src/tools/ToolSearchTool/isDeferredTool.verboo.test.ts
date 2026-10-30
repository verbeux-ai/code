import { describe, expect, mock, test } from 'bun:test'
import type { Tool } from '../../Tool.js'

const actualOauth = { ...(await import('../../constants/oauth.js')) }
let verbooMode = true
mock.module('../../constants/oauth.js', () => ({
  ...actualOauth,
  isVerbooMode: () => verbooMode,
}))

const { isDeferredTool } = await import('./prompt.js')
const { WebSearchTool } = await import('../WebSearchTool/WebSearchTool.js')
const { WebFetchTool } = await import('../WebFetchTool/WebFetchTool.js')

const deferrable = (name: string) => ({ name, shouldDefer: true }) as Tool

describe('isDeferredTool', () => {
  test('both web tools still declare shouldDefer', () => {
    expect(WebSearchTool.shouldDefer).toBe(true)
    expect(WebFetchTool.shouldDefer).toBe(true)
  })

  test('Verboo mode loads WebSearch and WebFetch up front', () => {
    // The OpenAI-compatible shim drops ToolSearch's tool_reference blocks, so
    // a deferred web tool would be "loaded" with an empty result.
    verbooMode = true
    expect(isDeferredTool(WebSearchTool as Tool)).toBe(false)
    expect(isDeferredTool(WebFetchTool as Tool)).toBe(false)
  })

  test('Verboo mode keeps deferring other shouldDefer and MCP tools', () => {
    verbooMode = true
    expect(isDeferredTool(deferrable('NotebookEdit'))).toBe(true)
    expect(isDeferredTool({ name: 'mcp__x__y', isMcp: true } as Tool)).toBe(true)
  })

  test('outside Verboo mode the web tools stay deferred', () => {
    verbooMode = false
    expect(isDeferredTool(WebSearchTool as Tool)).toBe(true)
    expect(isDeferredTool(WebFetchTool as Tool)).toBe(true)
  })
})
