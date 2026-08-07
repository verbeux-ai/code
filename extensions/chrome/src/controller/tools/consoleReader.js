/**
 * console.js — read console logs from the active tab.
 *
 * P5 implementation strategy:
 *   - Without the `debugger` permission, Chrome does not expose the
 *     Console domain to extensions. `chrome.scripting.executeScript`
 *     can only read messages already logged to `window.console` if the
 *     page is wrapping `console.*` — most pages don't.
 *   - With the `debugger` permission, the controller can attach
 *     `chrome.debugger` and call `Runtime.consoleAPICalled` to capture
 *     live messages. The permission is NOT in the current manifest
 *     (see PERMISSIONS.md "Future permission: debugger"), so this
 *     module returns an empty array with an explicit note instead of
 *     failing silently.
 *
 * Risk: `read`. The policy gate (evaluateToolPolicy) treats this as a
 * read; site grants (deny) and Hard Blocks apply normally.
 *
 * @param {{ name: 'console_reader'; action?: 'list' | 'clear'; risk?: string; input?: string }} tool
 * @returns {Promise<{ messages: Array<{ level: string; text: string; ts: number }>; note: string }>}
 */
export async function consoleReader(tool) {
  const action = tool?.action ?? 'list'
  if (action === 'clear') {
    return clearConsole()
  }
  return listConsole()
}

async function listConsole() {
  const hasDebugger = await hasDebuggerPermission()
  if (!hasDebugger) {
    return {
      messages: [],
      note: 'console_readback_unavailable: requires "debugger" permission (see PERMISSIONS.md)',
    }
  }
  // When the debugger permission ships, this branch attaches the
  // debugger, captures Runtime.consoleAPICalled events while a small
  // listening window is open, and detaches. For now we never reach
  // here — the gate above returns early. This branch is the future
  // implementation hook, kept to document the contract.
  const events = await captureConsoleEvents()
  return { messages: events, note: 'debugger_attached' }
}

async function clearConsole() {
  // script console.clear() works without the debugger permission.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('console.clear: no active tab')
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => { try { console.clear() } catch { /* readonly console */ } },
  })
  return { messages: [], note: 'cleared' }
}

/**
 * Detect whether the `debugger` permission is currently granted to this
 * extension. Chrome exposes `chrome.debugger` only when the permission
 * is in the manifest. We probe `typeof chrome.debugger`.
 * @returns {Promise<boolean>}
 */
function hasDebuggerPermission() {
  try {
    return typeof chrome !== 'undefined' && typeof chrome.debugger !== 'undefined'
  } catch {
    return false
  }
}

/**
 * Future: capture Runtime.consoleAPICalled events via the Chrome
 * DevTools Protocol while the debugger is attached. This is a
 * documented stub — the implementation lands when the `debugger`
 * permission is added to the manifest (see PERMISSIONS.md).
 * @returns {Promise<Array<{ level: string; text: string; ts: number }>>}
 */
async function captureConsoleEvents() {
  // Implementation contract (not yet active):
  //   1. chrome.debugger.attach({ tabId }, '1.3')
  //   2. subscribe to Runtime.consoleAPICalled via debugger events
  //   3. wait N ms or M events, then chrome.debugger.detach
  //   4. return collected messages with level + args + timestamp
  //
  // Until debugger permission ships, this is unreachable. Returning
  // [] is the documented safe default.
  return []
}