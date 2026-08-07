import { test } from 'node:test'
import assert from 'node:assert/strict'
import { structuredExtract } from './structuredExtract.js'

test('structuredExtract formats a table as CSV and keeps the agent tab target', async () => {
  const originalChrome = globalThis.chrome
  const executed = []
  globalThis.chrome = {
    tabs: {
      get: async (tabId) => ({ id: tabId, url: 'https://example.com/table' }),
      query: async () => [],
    },
    scripting: {
      executeScript: async (options) => {
        executed.push(options)
        return [{ result: { kind: 'table', headers: ['Name', 'Score'], rows: [{ Name: 'Ada', Score: '10' }] } }]
      },
    },
  }
  try {
    const result = await structuredExtract(
      { name: 'structured_extract', format: 'csv', selector: 'table' },
      { activeTabId: 12 },
    )
    assert.equal(result.data, 'Name,Score\nAda,10')
    assert.equal(executed[0].target.tabId, 12)
  } finally {
    globalThis.chrome = originalChrome
  }
})
