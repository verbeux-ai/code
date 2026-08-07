/**
 * find.js — discover real, clickable references on the current page by
 * visible text (optionally scoped to a CSS selector).
 *
 * G1-CHROME: the model must never guess CSS selectors from memory when the
 * user names a target. This tool reads the page and returns matches with a
 * working selector DERIVED FROM THE ACTUAL ELEMENT (title / aria-label /
 * href / DOM path). The selector is generic — no site-specific knowledge
 * is embedded anywhere.
 */

import { isControllableUrl, nonControllablePageMessage } from '../../planMessage.js'
import { preparePresenceForAction } from '../../presence/inject.js'

const MAX_MATCHES = 20

/**
 * @param {{ name: 'find'; text?: string; selector?: string; risk?: string; input?: string }} tool
 * @param {{ activeTabId?: number }} [ctx]
 * @returns {Promise<{ matches: Array<{ text: string; tag: string; selector: string; href?: string }>, url: string }>}
 */
export async function findTool(tool, ctx = {}) {
  const text = tool?.text
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new Error('find: text is required')
  }

  const tab = await resolveTargetTab(ctx?.activeTabId)
  if (!tab?.id) throw new Error('find: no active tab')

  if (!isControllableUrl(tab.url)) {
    throw new Error(nonControllablePageMessage(tab.url))
  }

  await preparePresenceForAction(tab.id, typeof tool?.selector === 'string' ? tool.selector : undefined)

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: findInPage,
    args: [text.trim(), tool?.selector ?? null],
  })

  if (!result) throw new Error('find: no result from page')
  return {
    matches: Array.isArray(result.result) ? result.result : [],
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
 * Returns up to MAX_MATCHES clickable elements whose visible text contains
 * the needle (case-insensitive). Selectors are derived from the element.
 * @param {string} text
 * @param {string | null} scopeSelector
 * @returns {Array<{ text: string; tag: string; selector: string; href?: string }>}
 */
function findInPage(text, scopeSelector) {
  const scope = scopeSelector
    ? document.querySelector(scopeSelector)
    : document
  if (!scope) return []

  const candidates = scope.querySelectorAll(
    'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], summary, label, input[type="submit"], input[type="button"]',
  )
  const needle = text.toLowerCase()
  const matches = []

  for (const el of candidates) {
    if (matches.length >= MAX_MATCHES) break
    const visible = (el.innerText ?? el.textContent ?? '').trim()
    if (!visible) continue
    if (!visible.toLowerCase().includes(needle)) continue

    const match = {
      text: visible.length > 200 ? `${visible.slice(0, 200)}…` : visible,
      tag: el.tagName.toLowerCase(),
      selector: buildSelector(el),
    }
    if (el.href) match.href = el.href
    matches.push(match)
  }

  return matches
}

/**
 * Derive a stable CSS selector from the REAL element. Preference order:
 * title attribute → aria-label → exact href → DOM path. No site-specific
 * knowledge is embedded.
 * @param {Element} el
 */
function buildSelector(el) {
  const title = el.getAttribute?.('title')
  if (title) return `[title="${escapeAttr(title)}"]`
  const aria = el.getAttribute?.('aria-label')
  if (aria) return `[aria-label="${escapeAttr(aria)}"]`
  if (el.tagName === 'A' && el.getAttribute?.('href')) {
    return `a[href="${escapeAttr(el.getAttribute('href'))}"]`
  }
  const parts = []
  let node = el
  while (node && node !== document.documentElement) {
    const tag = node.tagName.toLowerCase()
    const parent = node.parentElement
    const siblings = parent
      ? [...parent.children].filter((sibling) => sibling.tagName === node.tagName)
      : []
    const index = siblings.length > 1 ? siblings.indexOf(node) + 1 : 1
    parts.unshift(index > 1 ? `${tag}:nth-of-type(${index})` : tag)
    node = parent
  }
  return parts.join(' > ')
}

/** @param {string} value */
function escapeAttr(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}
