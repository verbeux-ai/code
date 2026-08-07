import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readPage } from './readPage.js'

test('readPage targets the tab supplied by the agent context', async () => {
  const originalChrome = globalThis.chrome
  const queried = []
  const executed = []

  globalThis.chrome = {
    tabs: {
      get: async (tabId) => ({ id: tabId, url: 'https://example.com', windowId: 7 }),
      query: async (query) => {
        queried.push(query)
        return [{ id: 99, url: 'https://wrong-tab.example', windowId: 7 }]
      },
    },
    scripting: {
      executeScript: async (options) => {
        executed.push(options)
        const source = String(options.func)
        if (source.includes('readInPage')) return [{ result: 'Target page content' }]
        if (source.includes('matchMedia')) return [{ result: true }]
        return [{ result: null }]
      },
    },
  }

  try {
    const result = await readPage(
      { name: 'read_page', selector: 'main' },
      { activeTabId: 42 },
    )

    assert.equal(result.text, 'Target page content')
    assert.equal(result.url, 'https://example.com')
    assert.equal(queried.length, 0, 'a valid agent tab id should not fall back to the active-tab query')
    assert.equal(executed.at(-1).target.tabId, 42)
  } finally {
    globalThis.chrome = originalChrome
  }
})

test('readPage keeps visible layout separators instead of concatenating elements', async () => {
  const originalChrome = globalThis.chrome
  const originalDocument = globalThis.document
  const executed = []

  globalThis.chrome = {
    tabs: {
      get: async (tabId) => ({ id: tabId, url: 'https://example.com', windowId: 7 }),
      query: async () => [],
    },
    scripting: {
      executeScript: async (options) => {
        executed.push(options)
        if (String(options.func).includes('readInPage')) return [{ result: options.func(...options.args) }]
        if (String(options.func).includes('matchMedia')) return [{ result: true }]
        return [{ result: null }]
      },
    },
  }
  globalThis.document = {
    body: { innerText: 'Example Domain\nThis domain is for documentation.' },
    querySelector: () => ({ innerText: 'Example Domain\nThis domain is for documentation.' }),
  }

  try {
    const result = await readPage({ name: 'read_page' }, { activeTabId: 42 })
    assert.equal(result.text, 'Example Domain\nThis domain is for documentation.')
    assert.ok(executed.some((options) => String(options.func).includes('innerText')))
  } finally {
    globalThis.chrome = originalChrome
    globalThis.document = originalDocument
  }
})
