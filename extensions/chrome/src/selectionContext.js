/**
 * User-selected page text for the Verboo context-menu entry point.
 *
 * This is intentionally separate from browser tools: the only page read here
 * is `window.getSelection()` immediately following an explicit context-menu
 * gesture. The text remains local until the panel starts a chat turn, where
 * the agent loop fences it as untrusted browser content.
 */

import { MSG } from './controller/protocol.js'

export const SELECTION_CONTEXT_MENU_ID = 'verboo:ask-selected-text'
export const SELECTION_CONTEXT_STORAGE_KEY = 'verbooSelectionContexts'

/**
 * Install or refresh the one selected-text menu item. `contexts: ['selection']`
 * keeps it out of page, image, media, and editable-menu surfaces.
 *
 * @returns {Promise<void>}
 */
export async function installSelectionContextMenu() {
  try {
    await chrome.contextMenus.remove(SELECTION_CONTEXT_MENU_ID)
  } catch {
    // First install has no prior item to remove.
  }
  chrome.contextMenus.create({
    id: SELECTION_CONTEXT_MENU_ID,
    title: chrome.i18n.getMessage('contextMenuAskVerboo') || 'Ask Verboo',
    contexts: ['selection'],
  })
}

/**
 * Read the live selection from the exact frame that produced the context-menu
 * event. This function is only invoked after `sidePanel.open()` was called by
 * the click handler; it never mutates the page or evaluates page-provided code.
 *
 * @param {number} tabId
 * @param {number} frameId
 * @returns {Promise<string>}
 */
export async function readSelectionFromPage(tabId, frameId) {
  if (!Number.isInteger(tabId)) throw new Error('selection_context_missing_tab')
  if (!Number.isInteger(frameId)) throw new Error('selection_context_missing_frame')
  const [result] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: readSelectionInPage,
  })
  if (!result || typeof result.result !== 'string') {
    throw new Error('selection_context_unavailable')
  }
  return result.result
}

function readSelectionInPage() {
  return globalThis.getSelection?.()?.toString() ?? ''
}

/**
 * @typedef {{
 *   id: string,
 *   tabId: number,
 *   frameId: number,
 *   text: string,
 *   verification: 'pending'|'complete'|'incomplete',
 * }} PendingSelectionContext
 */

/**
 * Store selection contexts by tab so the panel can recover its context if it
 * starts after the service worker broadcast. Mutations are serialized so a
 * late full-selection read cannot resurrect a context already consumed or
 * dismissed by the user.
 *
 * @param {{get: (key: string) => Promise<Record<string, unknown>>, set: (items: Record<string, unknown>) => Promise<void>}} options.storage
 * @param {(tabId: number) => Promise<void>} options.openPanel
 * @param {(tabId: number, frameId: number) => Promise<string>} options.readSelection
 * @param {(message: Record<string, unknown>) => void} options.broadcast
 * @param {() => string} [options.createId]
 */
export function createSelectionContextController({
  storage,
  openPanel,
  readSelection,
  broadcast,
  createId = () => crypto.randomUUID(),
}) {
  let write = Promise.resolve()
  /** @type {Map<string, Promise<void>>} */
  const pendingCompletions = new Map()

  const readContexts = async () => {
    const result = await storage.get(SELECTION_CONTEXT_STORAGE_KEY)
    const contexts = result?.[SELECTION_CONTEXT_STORAGE_KEY]
    if (!contexts || typeof contexts !== 'object' || Array.isArray(contexts)) return {}
    return { ...contexts }
  }

  const mutateContexts = (mutate) => {
    const task = write.then(async () => {
      const contexts = await readContexts()
      const result = await mutate(contexts)
      await storage.set({ [SELECTION_CONTEXT_STORAGE_KEY]: contexts })
      return result
    })
    write = task.catch(() => {})
    return task
  }

  /** @param {PendingSelectionContext} context */
  const put = (context) => mutateContexts((contexts) => {
    contexts[String(context.tabId)] = context
    return context
  })

  /** @param {PendingSelectionContext} context */
  const replaceIfCurrent = (context) => mutateContexts((contexts) => {
    const existing = contexts[String(context.tabId)]
    if (existing?.id !== context.id) return null
    contexts[String(context.tabId)] = context
    return context
  })

  /** @param {PendingSelectionContext} context */
  const notify = (context) => {
    broadcast({
      type: MSG.SELECTION_CONTEXT_CHANGED,
      tabId: context.tabId,
      context,
    })
  }

  /**
   * The first statement that can touch async work is deliberately the panel
   * opening invocation. Do not insert an await before `openPanel(tab.id)`.
   */
  async function handleContextMenuClick(info, tab) {
    if (info?.menuItemId !== SELECTION_CONTEXT_MENU_ID || !Number.isInteger(tab?.id)) {
      return false
    }

    const panelOpening = openPanel(tab.id)
    const context = {
      id: createId(),
      tabId: tab.id,
      frameId: Number.isInteger(info.frameId) ? info.frameId : 0,
      text: String(info.selectionText ?? ''),
      verification: 'pending',
    }
    await put(context)

    const completion = completeSelectionContext(context, panelOpening)
    pendingCompletions.set(context.id, completion)
    void completion.finally(() => {
      if (pendingCompletions.get(context.id) === completion) {
        pendingCompletions.delete(context.id)
      }
    })
    notify(context)
    await completion
    return true
  }

  /**
   * @param {PendingSelectionContext} context
   * @param {Promise<void>} panelOpening
   */
  async function completeSelectionContext(context, panelOpening) {
    try {
      await panelOpening
      const text = await readSelection(context.tabId, context.frameId)
      if (!hasSelectionText(text)) throw new Error('selection_context_empty')
      const complete = { ...context, text, verification: 'complete' }
      if (await replaceIfCurrent(complete)) notify(complete)
    } catch {
      const incomplete = { ...context, verification: 'incomplete' }
      if (await replaceIfCurrent(incomplete)) notify(incomplete)
    }
  }

  async function getPendingSelectionContext(tabId) {
    if (!Number.isInteger(tabId)) return null
    await write
    const contexts = await readContexts()
    const context = contexts[String(tabId)]
    return isPendingSelectionContext(context) ? { ...context } : null
  }

  async function consumePendingSelectionContext(tabId, contextId) {
    if (!Number.isInteger(tabId) || typeof contextId !== 'string' || !contextId) return null
    await pendingCompletions.get(contextId)
    return mutateContexts((contexts) => {
      const context = contexts[String(tabId)]
      if (!isPendingSelectionContext(context) || context.id !== contextId) return null
      delete contexts[String(tabId)]
      return context
    })
  }

  async function discardPendingSelectionContext(tabId, contextId) {
    if (!Number.isInteger(tabId) || typeof contextId !== 'string' || !contextId) return false
    return mutateContexts((contexts) => {
      const context = contexts[String(tabId)]
      if (!isPendingSelectionContext(context) || context.id !== contextId) return false
      delete contexts[String(tabId)]
      return true
    })
  }

  return {
    handleContextMenuClick,
    getPendingSelectionContext,
    consumePendingSelectionContext,
    discardPendingSelectionContext,
  }
}

function hasSelectionText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isPendingSelectionContext(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    Number.isInteger(value.tabId) &&
    Number.isInteger(value.frameId) &&
    typeof value.text === 'string' &&
    ['pending', 'complete', 'incomplete'].includes(value.verification),
  )
}
