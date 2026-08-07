/**
 * inject.test.js — pure-logic unit tests for presence constants/helpers.
 *
 * Most tests use pure helpers; the generation regression tests also execute
 * the serialized in-page functions in jsdom.
 * Run with: node --test src/presence/inject.test.js
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import {
  VERBOO_TAB_GROUP_TITLE,
  VERBOO_TAB_GROUP_COLOR,
  PRESENCE_ACTION_DELAY_MS,
  PRESENCE_ACTION_DELAY_MS_MIN,
  PRESENCE_ACTION_DELAY_MS_MAX,
  CURSOR_MOVE_MS,
  randomBetween,
  clearPresence,
  clearPresenceBestEffort,
  clearPresenceOnAllTabs,
  ensureAgentPresence,
  showPresenceFrame,
} from './inject.js'

test('Verboo tab group title is "Verboo"', () => {
  assert.equal(VERBOO_TAB_GROUP_TITLE, 'Verboo')
})

test('Verboo tab group color is chrome.tabGroups purple', () => {
  assert.equal(VERBOO_TAB_GROUP_COLOR, 'purple')
})

test('presence action delay is visible long enough (cursor dwell)', () => {
  assert.equal(CURSOR_MOVE_MS, 760)
  assert.equal(PRESENCE_ACTION_DELAY_MS_MIN, 840)
  assert.equal(PRESENCE_ACTION_DELAY_MS_MAX, 980)
  assert.ok(PRESENCE_ACTION_DELAY_MS >= 840)
  assert.ok(PRESENCE_ACTION_DELAY_MS <= 980)
  assert.ok(PRESENCE_ACTION_DELAY_MS_MIN > CURSOR_MOVE_MS)
})

test('randomBetween stays within [min, max]', () => {
  for (let i = 0; i < 40; i++) {
    const n = randomBetween(840, 980)
    assert.ok(n >= 840 && n <= 980, `got ${n}`)
  }
})

test('clearPresence and clearPresenceBestEffort are exported functions', () => {
  assert.equal(typeof clearPresence, 'function')
  assert.equal(typeof clearPresenceBestEffort, 'function')
  assert.equal(typeof clearPresenceOnAllTabs, 'function')
})

test('ensureAgentPresence and pulseAgentCursor are exported', async () => {
  const mod = await import('./inject.js')
  assert.equal(typeof mod.ensureAgentPresence, 'function')
  assert.equal(typeof mod.pulseAgentCursor, 'function')
  assert.equal(typeof mod.preparePresenceForAction, 'function')
  assert.equal(typeof mod.showAgentCursor, 'function')
})

test('showAgentCursor passes the slower Flow duration to the page injector', async () => {
  const mod = await import('./inject.js')
  const originalChrome = globalThis.chrome
  const calls = []
  globalThis.chrome = {
    scripting: {
      executeScript: async (options) => calls.push(options),
    },
  }
  try {
    await mod.showAgentCursor(42, { x: 120, y: 240 })
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].args.slice(0, 3), [
      'verboo-agent-cursor',
      'verboo-agent-cursor-style',
      { x: 120, y: 240 },
    ])
    assert.equal(calls[0].args[3], CURSOR_MOVE_MS)
  } finally {
    globalThis.chrome = originalChrome
  }
})

test('clearPresence no-ops without a numeric tabId', async () => {
  await assert.doesNotReject(() => clearPresence(/** @type {any} */ (undefined)))
  await assert.doesNotReject(() => clearPresence(/** @type {any} */ (null)))
})

test('openVerbooPanel opens the scoped panel before configuration settles', async () => {
  const mod = await import('./inject.js')
  assert.equal(typeof mod.openVerbooPanel, 'function')

  const originalChrome = globalThis.chrome
  const calls = []
  let finishPanelConfiguration
  globalThis.chrome = {
    sidePanel: {
      setOptions: (options) => {
        calls.push(['setOptions', options])
        return new Promise((resolve) => {
          finishPanelConfiguration = resolve
        })
      },
      open: async (options) => calls.push(['open', options]),
    },
  }
  try {
    const opening = mod.openVerbooPanel(42)
    await Promise.resolve()
    assert.deepEqual(calls, [
      ['setOptions', {
        tabId: 42,
        path: 'src/panel/panel.html',
        enabled: true,
      }],
      ['open', { tabId: 42 }],
    ], 'sidePanel.open must run before any awaited panel configuration')
    finishPanelConfiguration()
    await opening
  } finally {
    globalThis.chrome = originalChrome
  }
})

test('openVerbooWorkspace scopes the panel to one tab and groups that tab', async () => {
  const mod = await import('./inject.js')
  assert.equal(typeof mod.openVerbooWorkspace, 'function')

  const originalChrome = globalThis.chrome
  const calls = []
  let finishPanelConfiguration
  globalThis.chrome = {
    sidePanel: {
      setOptions: (options) => {
        calls.push(['setOptions', options])
        return new Promise((resolve) => {
          finishPanelConfiguration = resolve
        })
      },
      open: async (options) => calls.push(['open', options]),
    },
    tabs: {
      get: async (tabId) => ({ id: tabId, windowId: 3, groupId: -1 }),
      group: async (options) => {
        calls.push(['group', options])
        return 12
      },
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      query: async () => [],
      update: async (groupId, options) => calls.push(['updateGroup', groupId, options]),
    },
  }
  try {
    const workspace = mod.openVerbooWorkspace(42)
    await Promise.resolve()
    assert.deepEqual(calls.slice(0, 2), [
      ['setOptions', {
        tabId: 42,
        path: 'src/panel/panel.html',
        enabled: true,
      }],
      ['open', { tabId: 42 }],
    ], 'sidePanel.open must be invoked before awaiting setOptions so the toolbar gesture is preserved')
    finishPanelConfiguration()
    await workspace
    assert.deepEqual(calls, [
      ['setOptions', {
        tabId: 42,
        path: 'src/panel/panel.html',
        enabled: true,
      }],
      ['open', { tabId: 42 }],
      ['group', { tabIds: [42] }],
      ['updateGroup', 12, { title: 'Verboo', color: 'purple' }],
    ])
  } finally {
    globalThis.chrome = originalChrome
  }
})

test('disableGlobalVerbooPanel removes the global fallback panel', async () => {
  const mod = await import('./inject.js')
  assert.equal(typeof mod.disableGlobalVerbooPanel, 'function')

  const originalChrome = globalThis.chrome
  const calls = []
  globalThis.chrome = {
    sidePanel: {
      setOptions: async (options) => calls.push(options),
    },
  }
  try {
    await mod.disableGlobalVerbooPanel()
    assert.deepEqual(calls, [{ enabled: false }])
  } finally {
    globalThis.chrome = originalChrome
  }
})

test('turn cleanup clears a touched background tab outside the group and active-tab heuristics', async () => {
  const originalChrome = globalThis.chrome
  const calls = []
  globalThis.chrome = {
    scripting: {
      executeScript: async (options) => calls.push(options),
    },
    tabGroups: {
      query: async () => [],
    },
    windows: {
      getAll: async () => [{ id: 1 }],
    },
    tabs: {
      query: async (query) => (query.active ? [{ id: 2 }] : []),
    },
  }
  try {
    await ensureAgentPresence(99)
    calls.length = 0

    await clearPresenceOnAllTabs()

    assert.ok(
      calls.some((call) => call.target?.tabId === 99),
      'a touched background tab must be included even when it is not grouped or active',
    )
  } finally {
    globalThis.chrome = originalChrome
  }
})

test('a presence injection that completes after turn cleanup removes its stale frame', async () => {
  const originalChrome = globalThis.chrome
  const injectionStarted = new Promise((resolve) => {
    globalThis.__resolvePresenceInjectionStarted = resolve
  })
  let finishInjection
  let framePresent = false

  globalThis.chrome = {
    scripting: {
      executeScript: (options) => {
        if (options.func.name === 'injectPresenceFrameInPage') {
          globalThis.__resolvePresenceInjectionStarted()
          return new Promise((resolve) => {
            finishInjection = () => {
              framePresent = true
              resolve([])
            }
          })
        }
        if (options.func.name === 'removeByIdsInPage') {
          framePresent = false
        }
        return Promise.resolve([])
      },
    },
    tabGroups: {
      query: async () => [],
    },
    windows: {
      getAll: async () => [],
    },
    tabs: {
      query: async () => [],
    },
  }
  try {
    const injection = showPresenceFrame(77)
    await injectionStarted

    await clearPresenceOnAllTabs()
    assert.equal(framePresent, false, 'cleanup must run while injection is still pending')

    finishInjection()
    await injection

    assert.equal(framePresent, false, 'a stale injection must clean up after it completes')
  } finally {
    delete globalThis.__resolvePresenceInjectionStarted
    globalThis.chrome = originalChrome
  }
})

test('cleanup from a new service-worker life removes a frame from the previous life', async () => {
  const mod = await import('./inject.js?presence-dom-red')
  const originalChrome = globalThis.chrome
  const calls = []
  let persistedGeneration = 3
  globalThis.chrome = {
    scripting: {
      executeScript: async (options) => {
        calls.push(options)
        return []
      },
    },
    storage: {
      session: {
        get: async () => ({ verbooPresenceGeneration: persistedGeneration }),
        set: async (values) => {
          if (Object.hasOwn(values, 'verbooPresenceGeneration')) {
            persistedGeneration = values.verbooPresenceGeneration
          }
        },
      },
    },
    tabGroups: {
      query: async () => [],
    },
    windows: {
      getAll: async () => [],
    },
    tabs: {
      query: async () => [],
    },
  }
  try {
    await mod.ensureAgentPresence(77)
    calls.length = 0
    await mod.clearPresenceOnAllTabs()
    const cleanup = calls.find((call) => call.func.name === 'removeByIdsInPage')
    assert.ok(cleanup)

    const dom = new JSDOM(
      '<div id="verboo-presence-frame" data-verboo-presence-generation="3"></div>',
      { runScripts: 'outside-only' },
    )
    const removeByIdsInPage = dom.window.eval(`(${cleanup.func.toString()})`)
    removeByIdsInPage(...cleanup.args)

    assert.equal(
      dom.window.document.getElementById('verboo-presence-frame'),
      null,
      'cleanup must remove a frame born before the service-worker restart',
    )
    assert.equal(cleanup.args[1], 3)
  } finally {
    globalThis.chrome = originalChrome
  }
})

test('a service-worker recycle preserves ordering for a high-generation frame', async () => {
  const originalChrome = globalThis.chrome
  const calls = []
  let persistedGeneration = 3
  globalThis.chrome = {
    scripting: {
      executeScript: async (options) => {
        calls.push(options)
        return []
      },
    },
    storage: {
      session: {
        get: async () => ({ verbooPresenceGeneration: persistedGeneration }),
        set: async (values) => {
          if (Object.hasOwn(values, 'verbooPresenceGeneration')) {
            persistedGeneration = values.verbooPresenceGeneration
          }
        },
      },
    },
    tabGroups: {
      query: async () => [],
    },
    windows: {
      getAll: async () => [{ id: 1 }],
    },
    tabs: {
      query: async (query) => (query.active ? [{ id: 77 }] : []),
    },
  }
  try {
    const firstServiceWorker = await import('./inject.js?presence-recycle-first')
    await firstServiceWorker.showPresenceFrame(77, 3)
    const injection = calls.find((call) => call.func.name === 'injectPresenceFrameInPage')
    assert.ok(injection)

    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    })
    const injectPresenceFrameInPage = dom.window.eval(`(${injection.func.toString()})`)
    injectPresenceFrameInPage(...injection.args)
    assert.equal(
      dom.window.document.getElementById('verboo-presence-frame')?.dataset
        .verbooPresenceGeneration,
      '3',
    )

    calls.length = 0
    const restartedServiceWorker = await import('./inject.js?presence-recycle-second')
    await restartedServiceWorker.clearPresenceOnAllTabs()
    const cleanup = calls.find(
      (call) =>
        call.func.name === 'removeByIdsInPage' &&
        call.args[0].includes('verboo-presence-frame'),
    )
    assert.ok(cleanup)
    const removeByIdsInPage = dom.window.eval(`(${cleanup.func.toString()})`)
    removeByIdsInPage(...cleanup.args)

    assert.equal(
      dom.window.document.getElementById('verboo-presence-frame'),
      null,
      'cleanup after a service-worker recycle must remove the old frame',
    )
    assert.equal(cleanup.args[1], 3)
    assert.equal(persistedGeneration, 4)
  } finally {
    globalThis.chrome = originalChrome
  }
})

test('a newer frame survives cleanup that started in the previous generation', async () => {
  const mod = await import('./inject.js?presence-threshold-race')
  const originalChrome = globalThis.chrome
  const calls = []
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  })
  const discoveryStarted = new Promise((resolve) => {
    globalThis.__resolvePresenceDiscoveryStarted = resolve
  })
  let releaseDiscovery = () => {}
  let cleanupPromise

  const executeInDom = (options) => {
    const inPageFunction = dom.window.eval(`(${options.func.toString()})`)
    inPageFunction(...options.args)
  }

  globalThis.chrome = {
    scripting: {
      executeScript: async (options) => {
        calls.push(options)
        if (
          options.func.name === 'injectPresenceFrameInPage' ||
          options.func.name === 'removeByIdsInPage'
        ) {
          executeInDom(options)
        }
        return []
      },
    },
    tabGroups: {
      query: async () => {
        globalThis.__resolvePresenceDiscoveryStarted()
        return new Promise((resolve) => {
          releaseDiscovery = () => resolve([])
        })
      },
    },
    windows: {
      getAll: async () => [],
    },
    tabs: {
      query: async () => [],
    },
  }

  try {
    await mod.showPresenceFrame(77)
    assert.equal(
      dom.window.document.getElementById('verboo-presence-frame')?.dataset
        .verbooPresenceGeneration,
      '0',
    )

    cleanupPromise = mod.clearPresenceOnAllTabs()
    await discoveryStarted

    await mod.showPresenceFrame(77)
    assert.equal(
      dom.window.document.getElementById('verboo-presence-frame')?.dataset
        .verbooPresenceGeneration,
      '1',
    )

    releaseDiscovery()
    await cleanupPromise

    const cleanup = calls.find(
      (call) =>
        call.func.name === 'removeByIdsInPage' &&
        call.args[0].includes('verboo-presence-frame'),
    )
    assert.ok(cleanup)
    assert.equal(cleanup.args[1], 0)
    assert.ok(
      dom.window.document.getElementById('verboo-presence-frame'),
      'a frame injected after cleanup began must survive the older cleanup',
    )
  } finally {
    releaseDiscovery()
    if (cleanupPromise) await cleanupPromise.catch(() => {})
    delete globalThis.__resolvePresenceDiscoveryStarted
    globalThis.chrome = originalChrome
  }
})

test('cleanup reaches a controlled background tab while another tab is active', async () => {
  const mod = await import('./inject.js?presence-background-active')
  const originalChrome = globalThis.chrome
  const doms = new Map([
    [101, new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    })],
    [202, new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    })],
  ])
  const calls = []
  globalThis.chrome = {
    scripting: {
      executeScript: async (options) => {
        calls.push(options)
        const dom = doms.get(options.target.tabId)
        if (!dom) throw new Error('tab_closed')
        const inPageFunction = dom.window.eval(`(${options.func.toString()})`)
        return inPageFunction(...options.args)
      },
    },
    tabGroups: {
      query: async () => [],
    },
    windows: {
      getAll: async () => [{ id: 1 }],
    },
    tabs: {
      query: async (query) => (query.active ? [{ id: 202, windowId: 1 }] : []),
    },
  }
  try {
    await mod.showPresenceFrame(101)
    assert.ok(doms.get(101).window.document.getElementById('verboo-presence-frame'))

    await mod.clearPresenceOnAllTabs()

    assert.equal(
      doms.get(101).window.document.getElementById('verboo-presence-frame'),
      null,
      'the controlled background tab must be cleaned, not only the active tab',
    )
    assert.ok(
      calls.some((call) => call.target.tabId === 101),
      'cleanup must execute against the controlled background tab',
    )
  } finally {
    globalThis.chrome = originalChrome
  }
})

test('service-worker recycle preserves a background tab cleanup target', async () => {
  const originalChrome = globalThis.chrome
  const doms = new Map([
    [101, new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    })],
    [202, new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    })],
  ])
  const calls = []
  let persistedGeneration = 0
  let persistedTouchedTabGenerations = []
  const storage = {
    get: async () => ({
      verbooPresenceGeneration: persistedGeneration,
      verbooPresenceTouchedTabGenerations: persistedTouchedTabGenerations,
    }),
    set: async (values) => {
      if (Object.hasOwn(values, 'verbooPresenceGeneration')) {
        persistedGeneration = values.verbooPresenceGeneration
      }
      if (Object.hasOwn(values, 'verbooPresenceTouchedTabGenerations')) {
        persistedTouchedTabGenerations = values.verbooPresenceTouchedTabGenerations
      }
    },
  }
  globalThis.chrome = {
    scripting: {
      executeScript: async (options) => {
        calls.push(options)
        const dom = doms.get(options.target.tabId)
        if (!dom) throw new Error('tab_closed')
        const inPageFunction = dom.window.eval(`(${options.func.toString()})`)
        return inPageFunction(...options.args)
      },
    },
    storage: { session: storage },
    tabGroups: {
      query: async () => [],
    },
    windows: {
      getAll: async () => [{ id: 1 }],
    },
    tabs: {
      query: async (query) => (query.active ? [{ id: 202, windowId: 1 }] : []),
    },
  }
  try {
    const firstServiceWorker = await import('./inject.js?presence-background-life-one')
    await firstServiceWorker.showPresenceFrame(101)
    assert.ok(doms.get(101).window.document.getElementById('verboo-presence-frame'))

    const secondServiceWorker = await import('./inject.js?presence-background-life-two')
    await secondServiceWorker.clearPresenceOnAllTabs()

    assert.equal(
      doms.get(101).window.document.getElementById('verboo-presence-frame'),
      null,
      'cleanup in a new service-worker life must reach the background tab',
    )
    assert.ok(
      calls.some((call) => call.target.tabId === 101),
      'the persisted target must be included even though tab 202 is active',
    )
  } finally {
    globalThis.chrome = originalChrome
  }
})

test('cleanup tolerates a closed touched tab and drops its persisted target', async () => {
  const mod = await import('./inject.js?presence-closed-tab')
  const originalChrome = globalThis.chrome
  const activeDom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
  })
  let persistedTouchedTabGenerations = [{ tabId: 101, generation: 0 }]
  const calls = []
  globalThis.chrome = {
    scripting: {
      executeScript: async (options) => {
        calls.push(options)
        if (options.target.tabId === 101) throw new Error('tab_closed')
        const inPageFunction = activeDom.window.eval(`(${options.func.toString()})`)
        return inPageFunction(...options.args)
      },
    },
    storage: {
      session: {
        get: async () => ({
          verbooPresenceGeneration: 0,
          verbooPresenceTouchedTabGenerations: persistedTouchedTabGenerations,
        }),
        set: async (values) => {
          if (Object.hasOwn(values, 'verbooPresenceTouchedTabGenerations')) {
            persistedTouchedTabGenerations = values.verbooPresenceTouchedTabGenerations
          }
        },
      },
    },
    tabGroups: {
      query: async () => [],
    },
    windows: {
      getAll: async () => [{ id: 1 }],
    },
    tabs: {
      query: async (query) => (query.active ? [{ id: 202, windowId: 1 }] : []),
    },
  }
  try {
    await assert.doesNotReject(() => mod.clearPresenceOnAllTabs())
    assert.ok(
      calls.some((call) => call.target.tabId === 101),
      'the closed tab must still be attempted once so it can be retired',
    )
    assert.deepEqual(persistedTouchedTabGenerations, [])

    calls.length = 0
    await mod.clearPresenceOnAllTabs()
    assert.equal(
      calls.some((call) => call.target.tabId === 101),
      false,
      'a closed tab must not remain in the persisted target set',
    )
  } finally {
    globalThis.chrome = originalChrome
  }
})
