import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'

import { tabs } from './tabs.js'

const originalChrome = globalThis.chrome

afterEach(() => {
  globalThis.chrome = originalChrome
})

test('tabs lists, switches, and closes the requested tab', async () => {
  const updates = []
  const removals = []
  globalThis.chrome = {
    tabs: {
      query: async () => [
        { id: 11, url: 'https://example.com', title: 'Example', active: true, windowId: 2 },
        { id: 12, url: 'https://verboo.ai', title: 'Verboo', active: false, windowId: 2 },
      ],
      update: async (...args) => updates.push(args),
      remove: async (...args) => removals.push(args),
    },
  }

  const listed = await tabs({ name: 'tabs', action: 'list' })
  assert.equal(listed.count, 2)
  assert.deepEqual(listed.tabs.map((tab) => tab.id), [11, 12])

  assert.deepEqual(await tabs({ name: 'tabs', action: 'switch', tabId: 12 }), {
    tabId: 12,
    switched: true,
  })
  assert.deepEqual(updates, [[12, { active: true }]])

  assert.deepEqual(await tabs({ name: 'tabs', action: 'close', tabId: 11 }), {
    tabId: 11,
    closed: true,
  })
  assert.deepEqual(removals, [[11]])
})

test('tabs.new creates and groups an HTTP tab', async () => {
  const creates = []
  const grouped = []
  globalThis.chrome = {
    tabs: {
      create: async (options) => {
        creates.push(options)
        return { id: 31, windowId: 4, groupId: -1 }
      },
      get: async () => ({ id: 31, windowId: 4, groupId: -1 }),
      group: async (options) => {
        grouped.push(options)
        return 7
      },
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      query: async () => [],
      update: async () => {},
    },
  }

  const result = await tabs({ name: 'tabs', action: 'new', url: 'https://example.com/new' })

  assert.deepEqual(creates, [{ url: 'https://example.com/new' }])
  assert.deepEqual(grouped, [{ tabIds: [31] }])
  assert.deepEqual(result, { tabId: 31, url: 'https://example.com/new' })
})

test('tabs.new rejects privileged schemes before opening a tab', async () => {
  let created = false
  globalThis.chrome = {
    tabs: {
      create: async () => {
        created = true
      },
    },
  }

  await assert.rejects(
    () => tabs({ name: 'tabs', action: 'new', url: 'chrome://extensions' }),
    /unsupported scheme: chrome/,
  )
  assert.equal(created, false)
})
