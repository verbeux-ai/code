/**
 * screenshot.js — capture the visible tab as a PNG data URL.
 *
 * Uses chrome.tabs.captureVisibleTab (no debugger needed). For
 * fullPage captures we'd need chrome.debugger + Page.captureScreenshot
 * with `captureBeyondViewport: true` — that lands when the debugger
 * permission is re-added. For now, viewport-only.
 *
 * Chrome requires either `<all_urls>` host permission or temporary
 * `activeTab` for captureVisibleTab — plain http(s) patterns are NOT
 * enough (common "Could not capture" failure from the side panel).
 *
 * @param {{ name: 'screenshot'; format?: 'viewport' | 'fullPage'; risk?: string; input?: string }} tool
 * @param {{ activeTabId?: number }} [ctx]
 * @returns {Promise<{ dataUrl: string; format: string; width: number; height: number }>}
 */

import { preparePresenceForAction } from '../../presence/inject.js'

const CAPTURE_RETRIES = 4
const CAPTURE_RETRY_MS = 180

export async function screenshot(tool, ctx = {}) {
  const format = tool?.format ?? 'viewport'
  if (format === 'fullPage') {
    throw new Error('screenshot: fullPage requires debugger permission (not yet enabled)')
  }

  const tab = await resolveTargetTab(ctx?.activeTabId)
  if (!tab?.id) throw new Error('screenshot: no active tab')
  if (!tab.windowId && tab.windowId !== 0) {
    throw new Error('screenshot: active tab has no window')
  }

  const url = tab.url ?? ''
  if (url && !isCapturableUrl(url)) {
    throw new Error(
      `screenshot failed: cannot capture restricted page (${schemeOf(url) || 'unknown'}). Navigate to an http(s) page first.`,
    )
  }

  // Focus window + tab. captureVisibleTab needs the window focused; the
  // side panel often leaves the last browser window unfocused.
  try {
    await chrome.windows.update(tab.windowId, { focused: true })
  } catch {
    /* some window types reject focus — still try capture */
  }
  try {
    await chrome.tabs.update(tab.id, { active: true })
  } catch {
    /* ignore */
  }
  await sleep(80)

  // Keep agent cursor visible while capturing (frame + cursor = control UX).
  try {
    await preparePresenceForAction(tab.id)
  } catch {
    /* presence is best-effort */
  }

  const dataUrl = await captureWithRetries(tab.windowId)

  let width = 0
  let height = 0
  try {
    const [size] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({ w: window.innerWidth, h: window.innerHeight }),
    })
    width = size?.result?.w ?? 0
    height = size?.result?.h ?? 0
  } catch {
    /* size is optional — capture itself succeeded */
  }

  return {
    dataUrl,
    format: 'viewport',
    width,
    height,
  }
}

/**
 * Prefer an explicit tab id from the agent context; fall back to the
 * last focused normal browser window (not the side-panel's notion of current).
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

  // Prefer last focused normal window (service workers have no "current" UI).
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (tab?.id) return tab
  } catch {
    /* ignore */
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.id) return tab

  // Last resort: any active tab in a normal window.
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] })
  for (const win of windows) {
    const active = win.tabs?.find((t) => t.active)
    if (active?.id) return active
  }
  return null
}

/**
 * @param {number} windowId
 * @returns {Promise<string>}
 */
async function captureWithRetries(windowId) {
  let lastErr = null
  for (let attempt = 0; attempt < CAPTURE_RETRIES; attempt++) {
    if (attempt > 0) await sleep(CAPTURE_RETRY_MS * attempt)
    try {
      // Prefer jpeg for smaller LLM payloads; fall back to png.
      try {
        return await chrome.tabs.captureVisibleTab(windowId, {
          format: 'jpeg',
          quality: 85,
        })
      } catch {
        return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
      }
    } catch (err) {
      lastErr = err
    }
  }
  const detail = lastErr?.message ?? String(lastErr ?? 'captureVisibleTab denied')
  throw new Error(
    `screenshot failed: ${detail}. Ensure the browser window is focused and the page is http(s). Reload the extension after permission updates.`,
  )
}

/** @param {string} url */
function isCapturableUrl(url) {
  return /^https?:\/\//i.test(url) || /^file:\/\//i.test(url)
}

/** @param {string} url */
function schemeOf(url) {
  try {
    return new URL(url).protocol.replace(':', '')
  } catch {
    return ''
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
