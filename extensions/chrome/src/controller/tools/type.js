/**
 * type.js — type text into a form field in the active tab.
 *
 * Uses chrome.scripting.executeScript (no debugger needed). Clears
 * the field first if `clear` is true. Dispatches input + change events
 * so React/Vue controlled components pick up the value.
 *
 * Presence: shows the purple frame + purple agent cursor at the
 * target before typing so the user can see where Verboo will act.
 *
 * @param {{ name: 'type'; selector: string; text: string; clear?: boolean; risk?: string; input?: string }} tool
 * @returns {Promise<{ selector: string; textLength: number; url: string }>}
 */

import { preparePresenceForAction } from '../../presence/inject.js'

export async function typeText(tool) {
  const selector = tool?.selector
  if (!selector || typeof selector !== 'string') {
    throw new Error('type: missing selector')
  }
  const text = tool?.text
  if (typeof text !== 'string') throw new Error('type: missing text')
  const clear = tool?.clear === true

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('type: no active tab')

  // Agent presence: frame + cursor at target, brief delay, then type.
  await preparePresenceForAction(tab.id, selector)

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: typeInPage,
    args: [selector, text, clear],
  })

  if (!result) throw new Error('type: no result from page')
  if (!result.result) throw new Error(`type: element not found: ${selector}`)
  // SECURITY: never return the typed text in the result. The agent
  // transcript broadcasts AGENT_TOOL_RESULT to the panel; if we include
  // `text` here, secrets (passwords, API keys, 2FA codes) typed via
  // this tool would leak into the transcript. Return only the length
  // so the UI can show "typed 12 chars" without exposing the content.
  return { selector, textLength: text.length, url: tab.url ?? '' }
}

/**
 * In-page function. Returns true if the element was found and typed into.
 * @param {string} selector
 * @param {string} text
 * @param {boolean} clear
 * @returns {boolean}
 */
function typeInPage(selector, text, clear) {
  const el = /** @type {HTMLInputElement | HTMLTextAreaElement | null} */ (document.querySelector(selector))
  if (!el) return false
  el.focus()
  if (clear) {
    el.value = ''
  }
  // Use the native setter so React controlled components see the change.
  const proto = Object.getPrototypeOf(el)
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) {
    setter.call(el, text)
  } else {
    el.value = text
  }
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}
