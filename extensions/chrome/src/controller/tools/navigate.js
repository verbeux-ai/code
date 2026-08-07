/**
 * navigate.js — navigate the active tab to a URL.
 *
 * Uses chrome.tabs.update (no debugger needed). Validates URL scheme
 * to prevent chrome:// / file:// navigation from the controller path
 * (the URL policy gate in policy.js already blocks these, but we
 * double-check here as defense-in-depth).
 *
 * Presence: after load, groups the tab under "Verboo" and shows the
 * purple viewport frame + animated agent cursor on the new page.
 *
 * @param {{ name: 'navigate'; url: string; risk?: string; input?: string }} tool
 * @returns {Promise<{ tabId: number; url: string }>}
 */

import { ensureVerbooTabGroup, ensureAgentPresence } from '../../presence/inject.js'

export async function navigate(tool) {
  const url = tool?.url
  if (!url || typeof url !== 'string') {
    throw new Error('navigate: missing url')
  }
  // Defense-in-depth: reject non-http(s) schemes. The URL policy gate
  // already blocks chrome://, about:, etc., but a direct controller
  // caller could bypass it — so we re-check here.
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`navigate: unsupported scheme: ${url.split(':')[0]}`)
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('navigate: no active tab')

  await chrome.tabs.update(tab.id, { url })
  // Wait for the tab to finish loading so the caller can chain reads.
  await waitForTabComplete(tab.id)

  // Agent presence on the destination page (frame + cursor always).
  // YouTube SPA often paints after 'complete' — inject twice with a short gap.
  try {
    await ensureVerbooTabGroup(tab.id)
    await ensureAgentPresence(tab.id)
    await new Promise((r) => setTimeout(r, 350))
    await ensureAgentPresence(tab.id)
  } catch {
    // Non-controllable / race — never block navigation success.
  }

  return { tabId: tab.id, url }
}

/**
 * Resolves when the tab's status becomes 'complete', or after 30s.
 * @param {number} tabId
 * @returns {Promise<void>}
 */
function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    let resolved = false
    const done = () => {
      if (resolved) return
      resolved = true
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') done()
    }
    chrome.tabs.onUpdated.addListener(listener)
    // Timeout fallback — some pages never fire 'complete' (e.g. SPA
    // navigations, downloads). 30s matches the design spec §6.4.
    setTimeout(done, 30_000)
  })
}
