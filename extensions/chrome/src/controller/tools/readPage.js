/**
 * readPage.js — read visible text (or an attribute) from the active tab.
 *
 * Uses chrome.scripting.executeScript (no debugger needed). The
 * injected function runs in the page's isolated world (MV3 default).
 *
 * Fails with a friendly error when the active tab is on a non-
 * controllable scheme (chrome://, about:, edge://, file://, etc.).
 * Chrome would otherwise throw a raw "Cannot access a chrome:// URL"
 * exception that's useless to the user.
 */

import { isControllableUrl, nonControllablePageMessage } from '../../planMessage.js'
import { preparePresenceForAction } from '../../presence/inject.js'

/**
 * @param {{ name: 'read_page'; selector?: string; attribute?: string; risk?: string; input?: string }} tool
 * @param {{ activeTabId?: number }} [ctx]
 * @returns {Promise<{ text: string; selector?: string; attribute?: string; url: string }>}
 */
export async function readPage(tool, ctx = {}) {
  const selector = tool?.selector
  const attribute = tool?.attribute

  const tab = await resolveTargetTab(ctx?.activeTabId)
  if (!tab?.id) throw new Error('read_page: no active tab')

  if (!isControllableUrl(tab.url)) {
    throw new Error(nonControllablePageMessage(tab.url))
  }

  // Cursor presence while reading so control never looks "invisible".
  await preparePresenceForAction(tab.id, typeof selector === 'string' ? selector : undefined)

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: readInPage,
    args: [selector ?? null, attribute ?? null],
  })

  if (!result) throw new Error('read_page: no result from page')
  return {
    text: String(result.result ?? ''),
    selector: selector,
    attribute: attribute,
    url: tab.url ?? '',
  }
}

/**
 * Prefer the tab captured when the panel turn started. A side panel can keep
 * a different window focused while its page remains the user's target; using
 * `currentWindow` alone can therefore inject into the wrong tab and return an
 * empty body. The fallback mirrors screenshot.js for older callers.
 * @param {number | undefined} preferredTabId
 */
async function resolveTargetTab(preferredTabId) {
  if (typeof preferredTabId === 'number') {
    try {
      const tab = await chrome.tabs.get(preferredTabId)
      if (tab?.id) return tab
    } catch {
      /* tab closed — fall through */
    }
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (tab?.id) return tab
  } catch {
    /* ignore */
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.id) return tab

  try {
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] })
    for (const win of windows) {
      const active = win.tabs?.find((candidate) => candidate.active)
      if (active?.id) return active
    }
  } catch {
    /* ignore */
  }
  return null
}

/**
 * In-page function. Runs in the page's main world via executeScript.
 * Returns visible innerText of the first match (or the whole document if
 * no selector). If `attribute` is set, returns that attribute's value
 * instead of visible text.
 * @param {string | null} selector
 * @param {string | null} attribute
 * @returns {string}
 */
function readInPage(selector, attribute) {
  const el = selector ? document.querySelector(selector) : document.body
  if (!el) return ''
  if (attribute) {
    const v = el.getAttribute(attribute)
    return v ?? ''
  }
  return el.innerText ?? el.textContent ?? ''
}
