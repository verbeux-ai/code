import { afterEach, expect, spyOn, test } from 'bun:test'
import axios from 'axios'

import { isOfficialMcpUrl, prefetchOfficialMcpUrls } from './officialRegistry.js'

const savedTraffic = process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC

afterEach(() => {
  if (savedTraffic === undefined) delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  else process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = savedTraffic
})

test('startup does not call the Anthropic MCP registry', async () => {
  delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  const get = spyOn(axios, 'get')
  await prefetchOfficialMcpUrls()
  expect(get).not.toHaveBeenCalled()
  expect(isOfficialMcpUrl('https://example.com/mcp')).toBe(false)
  get.mockRestore()
})
