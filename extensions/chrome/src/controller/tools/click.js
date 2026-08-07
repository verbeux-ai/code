/**
 * click.js — click an element in the active tab.
 *
 * Uses chrome.scripting.executeScript (no debugger needed). The
 * injected function dispatches a real PointerEvent so SPA click
 * handlers fire correctly.
 *
 * Presence: shows the purple frame + purple agent cursor at the
 * target before clicking so the user can see where Verboo will act.
 *
 * @param {{ name: 'click'; selector: string; button?: number; risk?: string; input?: string }} tool
 * @returns {Promise<{ selector: string; clicked: boolean; url: string }>}
 */

import { preparePresenceForAction, pulseAgentCursor } from '../../presence/inject.js'

export async function click(tool) {
  const selector = tool?.selector
  if (!selector || typeof selector !== 'string') {
    throw new Error('click: missing selector')
  }
  const button = typeof tool.button === 'number' ? tool.button : 0

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('click: no active tab')

  // Agent presence: frame + cursor glide to target, dwell, click pulse, then DOM click.
  await preparePresenceForAction(tab.id, selector)
  try {
    await pulseAgentCursor(tab.id)
  } catch {
    /* presence is best-effort */
  }

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: clickInPage,
    args: [selector, button],
  })

  if (!result) throw new Error('click: no result from page')
  if (!result.result) throw new Error(`click: element not found: ${selector}`)
  return { selector, clicked: true, url: tab.url ?? '' }
}

/**
 * In-page function. Returns true if the element was found and clicked.
 * @param {string} selector
 * @param {number} button
 * @returns {boolean}
 */
function clickInPage(selector, button) {
  const el = document.querySelector(selector)
  if (!el) return false
  el.scrollIntoView({ block: 'center', behavior: 'instant' })
  const rect = el.getBoundingClientRect()
  const opts = {
    bubbles: true,
    cancelable: true,
    view: window,
    button,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  }
  el.dispatchEvent(new PointerEvent('pointerdown', opts))
  el.dispatchEvent(new MouseEvent('mousedown', opts))
  el.dispatchEvent(new PointerEvent('pointerup', opts))
  el.dispatchEvent(new MouseEvent('mouseup', opts))
  el.dispatchEvent(new MouseEvent('click', opts))
  return true
}
