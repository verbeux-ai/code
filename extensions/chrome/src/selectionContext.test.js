import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MSG } from './controller/protocol.js'

const selectionContext = await import('./selectionContext.js').catch(() => null)

function requireSelectionContextModule() {
  assert.equal(typeof selectionContext?.createSelectionContextController, 'function')
  assert.equal(typeof selectionContext?.installSelectionContextMenu, 'function')
  assert.equal(typeof selectionContext?.readSelectionFromPage, 'function')
  return selectionContext
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function createStorage(calls = []) {
  const values = {}
  return {
    async get(key) {
      calls.push('storage.get')
      return { [key]: clone(values[key]) }
    },
    async set(next) {
      calls.push('storage.set')
      Object.assign(values, clone(next))
    },
  }
}

test('selected-text menu is registered only for text selections', async () => {
  const mod = requireSelectionContextModule()
  const originalChrome = globalThis.chrome
  const calls = []
  globalThis.chrome = {
    contextMenus: {
      remove: async (id) => calls.push(['remove', id]),
      create: (options) => calls.push(['create', options]),
    },
    i18n: {
      getMessage: (key) => key === 'contextMenuAskVerboo' ? 'Perguntar ao Verboo' : '',
    },
  }

  try {
    await mod.installSelectionContextMenu()
    assert.deepEqual(calls, [
      ['remove', mod.SELECTION_CONTEXT_MENU_ID],
      ['create', {
        id: mod.SELECTION_CONTEXT_MENU_ID,
        title: 'Perguntar ao Verboo',
        contexts: ['selection'],
      }],
    ])
  } finally {
    globalThis.chrome = originalChrome
  }
})

test('selection menu opens the panel before waiting for storage or a page read', async () => {
  const mod = requireSelectionContextModule()
  const calls = []
  const values = {}
  let releaseFirstRead
  let firstRead = true
  let releasePanelOpen
  const storage = {
    get: (key) => {
      calls.push('storage.get')
      if (firstRead) {
        firstRead = false
        return new Promise((resolve) => {
          releaseFirstRead = () => resolve({ [key]: clone(values[key]) })
        })
      }
      return Promise.resolve({ [key]: clone(values[key]) })
    },
    set: async (next) => {
      calls.push('storage.set')
      Object.assign(values, clone(next))
    },
  }
  const controller = mod.createSelectionContextController({
    storage,
    createId: () => 'selection-1',
    openPanel: () => {
      calls.push('openPanel')
      return new Promise((resolve) => {
        releasePanelOpen = () => {
          calls.push('panelOpened')
          resolve()
        }
      })
    },
    readSelection: async () => {
      calls.push('readSelection')
      return 'the complete selection'
    },
    broadcast: (message) => calls.push(['broadcast', message]),
  })

  const capture = controller.handleContextMenuClick({
    menuItemId: mod.SELECTION_CONTEXT_MENU_ID,
    selectionText: 'fallback selection',
    frameId: 0,
  }, { id: 42 })

  await Promise.resolve()
  assert.equal(calls[0], 'openPanel')
  assert.ok(calls.includes('storage.get'))
  assert.equal(calls.includes('readSelection'), false)

  releaseFirstRead()
  await Promise.resolve()
  releasePanelOpen()
  await capture

  assert.ok(calls.indexOf('panelOpened') < calls.indexOf('readSelection'))
  const context = await controller.getPendingSelectionContext(42)
  assert.deepEqual(context, {
    id: 'selection-1',
    tabId: 42,
    frameId: 0,
    text: 'the complete selection',
    verification: 'complete',
  })
})

test('failed full-selection reads remain visible as potentially incomplete', async () => {
  const mod = requireSelectionContextModule()
  const broadcasts = []
  const controller = mod.createSelectionContextController({
    storage: createStorage(),
    createId: () => 'selection-2',
    openPanel: async () => {},
    readSelection: async () => {
      throw new Error('cannot access page')
    },
    broadcast: (message) => broadcasts.push(message),
  })

  await controller.handleContextMenuClick({
    menuItemId: mod.SELECTION_CONTEXT_MENU_ID,
    selectionText: 'fallback selection',
    frameId: 7,
  }, { id: 43 })

  const context = await controller.getPendingSelectionContext(43)
  assert.equal(context?.verification, 'incomplete')
  assert.equal(context?.text, 'fallback selection')
  assert.equal(broadcasts.at(-1)?.type, MSG.SELECTION_CONTEXT_CHANGED)
  assert.equal(broadcasts.at(-1)?.context?.verification, 'incomplete')
})

test('the first submitted turn consumes and discards its pending selection', async () => {
  const mod = requireSelectionContextModule()
  const controller = mod.createSelectionContextController({
    storage: createStorage(),
    createId: () => 'selection-3',
    openPanel: async () => {},
    readSelection: async () => 'full selection',
    broadcast: () => {},
  })

  await controller.handleContextMenuClick({
    menuItemId: mod.SELECTION_CONTEXT_MENU_ID,
    selectionText: 'fallback selection',
    frameId: 0,
  }, { id: 44 })

  const consumed = await controller.consumePendingSelectionContext(44, 'selection-3')
  assert.equal(consumed?.text, 'full selection')
  assert.equal(await controller.getPendingSelectionContext(44), null)
  assert.equal(await controller.consumePendingSelectionContext(44, 'selection-3'), null)
})

test('a late complete-selection read cannot restore a dismissed context', async () => {
  const mod = requireSelectionContextModule()
  let releaseRead
  let readStarted
  const reading = new Promise((resolve) => {
    readStarted = resolve
  })
  const controller = mod.createSelectionContextController({
    storage: createStorage(),
    createId: () => 'selection-4',
    openPanel: async () => {},
    readSelection: async () => {
      readStarted()
      return new Promise((resolve) => {
        releaseRead = () => resolve('late complete selection')
      })
    },
    broadcast: () => {},
  })

  const capture = controller.handleContextMenuClick({
    menuItemId: mod.SELECTION_CONTEXT_MENU_ID,
    selectionText: 'fallback selection',
    frameId: 0,
  }, { id: 45 })

  await reading
  assert.equal(await controller.discardPendingSelectionContext(45, 'selection-4'), true)
  releaseRead()
  await capture

  assert.equal(await controller.getPendingSelectionContext(45), null)
})

test('full selection capture reads only the clicked frame', async () => {
  const mod = requireSelectionContextModule()
  const originalChrome = globalThis.chrome
  const calls = []
  globalThis.chrome = {
    scripting: {
      executeScript: async (options) => {
        calls.push(options)
        return [{ result: 'complete frame selection' }]
      },
    },
  }

  try {
    assert.equal(await mod.readSelectionFromPage(77, 0), 'complete frame selection')
    assert.deepEqual(calls[0].target, { tabId: 77, frameIds: [0] })
  } finally {
    globalThis.chrome = originalChrome
  }
})
