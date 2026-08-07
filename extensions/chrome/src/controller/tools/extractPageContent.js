/**
 * extractPageContent.js — extract the FULL text content of the current page
 * (or a CSS selector), including content far beyond the visible viewport.
 *
 * G3-CHROME: read_page results are truncated at MAX_RESULT_CHARS (4000) by
 * the agent loop, so a long page never reaches the model in full. This tool
 * returns the complete innerText; the loop chunks it into per-message slices
 * so the model receives the whole document.
 */

import { isControllableUrl, nonControllablePageMessage } from '../../planMessage.js'
import { preparePresenceForAction } from '../../presence/inject.js'

/**
 * @param {{ name: 'extract_page_content'; selector?: string; risk?: string; input?: string }} tool
 * @param {{ activeTabId?: number }} [ctx]
 * @returns {Promise<{ text: string; selector?: string; url: string }>}
 */
export async function extractPageContent(tool, ctx = {}) {
  const selector = tool?.selector

  const tab = await resolveTargetTab(ctx?.activeTabId)
  if (!tab?.id) throw new Error('extract_page_content: no active tab')

  if (!isControllableUrl(tab.url)) {
    throw new Error(nonControllablePageMessage(tab.url))
  }

  await preparePresenceForAction(tab.id, typeof selector === 'string' ? selector : undefined)

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: extractInPage,
    args: [selector ?? null],
  })

  if (!result) throw new Error('extract_page_content: no result from page')
  return {
    text: String(result.result ?? ''),
    selector,
    url: tab.url ?? '',
  }
}

/** @param {number | undefined} preferredTabId */
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
  return null
}

/**
 * In-page function. Runs in the page's main world via executeScript.
 * Returns the COMPLETE innerText of the selector match (or the body) —
 * no truncation here; chunking happens in the agent loop.
 * @param {string | null} selector
 * @returns {string}
 */
function extractInPage(selector) {
  const el = selector ? document.querySelector(selector) : document.body
  if (!el) return ''
  return el.innerText ?? el.textContent ?? ''
}
