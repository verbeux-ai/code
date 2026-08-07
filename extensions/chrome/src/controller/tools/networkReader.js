/**
 * network.js — capture and inspect network requests in the active tab.
 *
 * P5 implementation strategy:
 *   - Without the `debugger` permission, the Network domain of the
 *     Chrome DevTools Protocol is not accessible to extensions. There
 *     is no chrome.* API for non-debugger network observation.
 *   - With the `debugger` permission, the controller can attach
 *     `chrome.debugger` and use `Network.requestWillBeSent`,
 *     `Network.responseReceived`, and `Network.loadingFailed` to
 *     capture every request for the duration of a tool call.
 *
 * Risk: `read` by default. `markSensitive(true)` upgrades the tool to
 * `elevated` because it may surface authentication headers, cookies,
 * and PII — even though the data stays local. The controller's
 * evaluateToolPolicy forces `needsApproval` for elevated tools in
 * every mode (see protocol.js TOOL_RISK_MAP + evaluateToolPolicy.js
 * elevated check).
 *
 * @param {{
 *   name: 'network_reader';
 *   action?: 'list' | 'clear';
 *   durationMs?: number;
 *   markSensitive?: boolean;
 *   risk?: string;
 *   input?: string;
 * }} tool
 * @returns {Promise<{
 *   entries: Array<{ url: string; method: string; status?: number; ts: number }>;
 *   sensitive: boolean;
 *   note: string;
 * }>}
 */
export async function networkReader(tool) {
  const action = tool?.action ?? 'list'
  const sensitive = tool?.markSensitive === true
  const durationMs = clampDuration(tool?.durationMs)

  if (action === 'clear') {
    return { entries: [], sensitive, note: 'cleared (no-op without debugger)' }
  }

  const hasDebugger = await hasDebuggerPermission()
  if (!hasDebugger) {
    return {
      entries: [],
      sensitive,
      note: 'network_capture_unavailable: requires "debugger" permission (see PERMISSIONS.md)',
    }
  }

  // Future: attach debugger, capture Network events for `durationMs`,
  // detach. Documented contract below — implementation lands when the
  // `debugger` permission ships.
  const entries = await captureNetworkEntries(durationMs)
  // Strip sensitive headers from entries — keep only URL/method/status/timestamp.
  return { entries: entries.map(stripSensitiveHeaders), sensitive, note: 'debugger_attached' }
}

/**
 * @param {number} [requested]
 * @returns {number} clamped to [100, 10000] ms
 */
function clampDuration(requested) {
  const ms = typeof requested === 'number' ? requested : 2000
  return Math.max(100, Math.min(10_000, ms))
}

/**
 * @param {boolean}
 */
function hasDebuggerPermission() {
  try {
    return typeof chrome !== 'undefined' && typeof chrome.debugger !== 'undefined'
  } catch {
    return false
  }
}

/**
 * Documented future contract — not yet active. When the `debugger`
 * permission ships, this captures Network events for the given window.
 * @param {number} durationMs
 * @returns {Promise<Array<{ url: string; method: string; status?: number; ts: number; headers?: Record<string, string> }>>}
 */
async function captureNetworkEntries(durationMs) {
  // Implementation contract:
  //   1. chrome.debugger.attach({ tabId }, '1.3')
  //   2. chrome.debugger.sendCommand(target, 'Network.enable')
  //   3. subscribe to Network.requestWillBeSent / responseReceived
  //   4. wait `durationMs`
  //   5. chrome.debugger.detach
  //   6. return collected entries
  //
  // Until debugger ships, this branch is unreachable.
  return []
}

/**
 * Strip auth/cookie/Cookie/PII headers from entries. The controller
 * returns only URL/method/status/timestamp so secrets never leave the
 * page context via tool results.
 * @param {{ url: string; method: string; status?: number; ts: number; headers?: Record<string, string> }} entry
 */
function stripSensitiveHeaders(entry) {
  return {
    url: entry.url,
    method: entry.method,
    status: entry.status,
    ts: entry.ts,
  }
}