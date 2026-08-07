/**
 * presence/inject.js — agent presence for Verboo (tab group + frame + cursor).
 *
 * Visual + tab-group cues while Verboo controls the browser:
 *   - Purple "Verboo" tab group
 *   - Animated purple viewport frame
 *   - Classic purple SVG mouse-arrow cursor that moves to the interaction target
 *
 * Prefer chrome.scripting.executeScript (no content_scripts) so overlays
 * only appear during control. All public helpers are best-effort: failures
 * (chrome:// pages, missing permissions) are swallowed by callers so
 * presence never blocks real tool actions.
 *
 * Multi-user: zero hardcoded path/user/token.
 */

/** @type {string} */
export const VERBOO_TAB_GROUP_TITLE = 'Verboo'

/** chrome.tabGroups color enum value */
export const VERBOO_TAB_GROUP_COLOR = 'purple'

export const VERBOO_PANEL_PATH = 'src/panel/panel.html'

const FRAME_ID = 'verboo-presence-frame'
const FRAME_STYLE_ID = 'verboo-presence-frame-style'
const CURSOR_ID = 'verboo-agent-cursor'
const CURSOR_STYLE_ID = 'verboo-agent-cursor-style'
const CURSOR_RIPPLE_ID = 'verboo-agent-cursor-ripple'
const PRESENCE_GENERATION_STORAGE_KEY = 'verbooPresenceGeneration'
const PRESENCE_TOUCHED_TAB_GENERATIONS_STORAGE_KEY = 'verbooPresenceTouchedTabGenerations'

let presenceGeneration = 0
let presenceGenerationReady
let presenceGenerationWrite = Promise.resolve()
let presenceTouchedTabGenerationsWrite = Promise.resolve()
/** @type {Set<number>} */
const touchedPresenceTabIds = new Set()
/** @type {Map<number, number>} */
const touchedPresenceTabGenerations = new Map()

/**
 * @returns {{get?: Function, set?: Function} | undefined}
 */
function getPresenceSessionStorage() {
  return globalThis.chrome?.storage?.session
}

/** @returns {Promise<void>} */
async function restorePresenceGeneration() {
  const storage = getPresenceSessionStorage()
  if (typeof storage?.get !== 'function') return
  try {
    const result = await storage.get(PRESENCE_GENERATION_STORAGE_KEY)
    const storedGeneration = Number(result?.[PRESENCE_GENERATION_STORAGE_KEY])
    if (Number.isSafeInteger(storedGeneration) && storedGeneration >= 0) {
      presenceGeneration = storedGeneration
    }
  } catch {
    // Presence remains best-effort if session storage is unavailable.
  }
}

/** @returns {Promise<void>} */
async function restoreTouchedPresenceTabs() {
  const storage = getPresenceSessionStorage()
  if (typeof storage?.get !== 'function') return
  try {
    const result = await storage.get(PRESENCE_TOUCHED_TAB_GENERATIONS_STORAGE_KEY)
    const storedValue = result?.[PRESENCE_TOUCHED_TAB_GENERATIONS_STORAGE_KEY]
    touchedPresenceTabIds.clear()
    touchedPresenceTabGenerations.clear()
    if (!Array.isArray(storedValue)) return
    for (const entry of storedValue) {
      const tabId = Number(entry?.tabId)
      const generation = Number(entry?.generation)
      if (
        Number.isSafeInteger(tabId) && tabId >= 0 &&
        Number.isSafeInteger(generation) && generation >= 0
      ) {
        touchedPresenceTabIds.add(tabId)
        touchedPresenceTabGenerations.set(tabId, generation)
      }
    }
  } catch {
    // Presence remains best-effort if session storage is unavailable.
  }
}

/** @returns {Promise<void>} */
function ensurePresenceGenerationReady() {
  if (!presenceGenerationReady) {
    presenceGenerationReady = Promise.all([
      restorePresenceGeneration(),
      restoreTouchedPresenceTabs(),
    ]).then(() => {})
  }
  return presenceGenerationReady
}

/**
 * Serialize writes so concurrent turn teardowns cannot publish an older
 * generation after a newer one.
 *
 * @param {number} generation
 * @returns {Promise<void>}
 */
function persistPresenceGeneration(generation) {
  const storage = getPresenceSessionStorage()
  if (typeof storage?.set !== 'function') return Promise.resolve()
  const write = presenceGenerationWrite.then(() =>
    storage.set({ [PRESENCE_GENERATION_STORAGE_KEY]: generation }),
  )
  presenceGenerationWrite = write.catch(() => {})
  return presenceGenerationWrite
}

/**
 * Persist the tabs that still have presence born in this service-worker
 * state. Keeping the injection generation alongside each tab preserves the
 * cleanup threshold when a new injection races an older cleanup.
 *
 * @returns {Promise<void>}
 */
function persistTouchedPresenceTabs() {
  const storage = getPresenceSessionStorage()
  if (typeof storage?.set !== 'function') return Promise.resolve()
  const write = presenceTouchedTabGenerationsWrite.then(() =>
    storage.set({
      [PRESENCE_TOUCHED_TAB_GENERATIONS_STORAGE_KEY]: Array.from(
        touchedPresenceTabGenerations,
        ([tabId, generation]) => ({ tabId, generation }),
      ),
    }),
  )
  presenceTouchedTabGenerationsWrite = write.catch(() => {})
  return presenceTouchedTabGenerationsWrite
}

/**
 * @param {number} tabId
 * @returns {Promise<number>}
 */
async function rememberPresenceTab(tabId) {
  touchedPresenceTabIds.add(tabId)
  touchedPresenceTabGenerations.set(tabId, presenceGeneration)
  await persistTouchedPresenceTabs()
  return presenceGeneration
}

/** @returns {Promise<number>} */
async function advancePresenceGeneration() {
  presenceGeneration += 1
  const generation = presenceGeneration
  await persistPresenceGeneration(generation)
  return generation
}

/** Inclusive lower bound for the random presence pause (ms). */
export const PRESENCE_ACTION_DELAY_MS_MIN = 840
/** Inclusive upper bound for the random presence pause (ms). */
export const PRESENCE_ACTION_DELAY_MS_MAX = 980
/**
 * Representative delay in the presence range (for tests / docs).
 * Runtime uses {@link randomBetween} each action — long enough to see the cursor.
 */
export const PRESENCE_ACTION_DELAY_MS = 900

/** Cursor glide duration (ms) — matches in-page CSS transition. */
export const CURSOR_MOVE_MS = 760

/**
 * Inclusive integer random in [min, max].
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function randomBetween(min, max) {
  const lo = Math.ceil(min)
  const hi = Math.floor(max)
  return Math.floor(Math.random() * (hi - lo + 1)) + lo
}

// ── Tab group ──────────────────────────────────────────────────

/**
 * Disable the manifest's window-wide panel fallback. Individual tabs opt in
 * through {@link openVerbooWorkspace}, so switching tabs hides the panel.
 */
export async function disableGlobalVerbooPanel() {
  await chrome.sidePanel.setOptions({ enabled: false })
}

/**
 * Bind the Verboo panel to one tab and invoke its opening while the caller's
 * user gesture is still active. Do not add an await before `sidePanel.open`.
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
export function openVerbooPanel(tabId) {
  if (typeof tabId !== 'number') {
    throw new Error('openVerbooPanel: missing tabId')
  }
  const configurePanel = chrome.sidePanel.setOptions({
    tabId,
    path: VERBOO_PANEL_PATH,
    enabled: true,
  })
  const openPanel = chrome.sidePanel.open({ tabId })
  return Promise.all([configurePanel, openPanel]).then(() => {})
}

/**
 * Bind the Verboo panel to one tab, open it from the toolbar gesture, and put
 * the controlled tab in the Verboo group.
 *
 * @param {number} tabId
 * @returns {Promise<{ groupId: number }>}
 */
export async function openVerbooWorkspace(tabId) {
  await openVerbooPanel(tabId)
  return ensureVerbooTabGroup(tabId)
}

/**
 * Ensure `tabId` is in a purple tab group titled "Verboo".
 * Reuses an existing Verboo group in the same window when present.
 *
 * @param {number} tabId
 * @returns {Promise<{ groupId: number }>}
 */
export async function ensureVerbooTabGroup(tabId) {
  if (typeof tabId !== 'number') {
    throw new Error('ensureVerbooTabGroup: missing tabId')
  }

  const tab = await chrome.tabs.get(tabId)
  const windowId = tab.windowId

  // Prefer an existing Verboo group in this window.
  const existing = await chrome.tabGroups.query({
    title: VERBOO_TAB_GROUP_TITLE,
    windowId,
  })

  let groupId
  if (existing.length > 0) {
    groupId = await chrome.tabs.group({ groupId: existing[0].id, tabIds: [tabId] })
  } else if (
    tab.groupId != null &&
    tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE
  ) {
    // Tab already grouped — if that group is already Verboo, just restyle.
    try {
      const current = await chrome.tabGroups.get(tab.groupId)
      if (current.title === VERBOO_TAB_GROUP_TITLE) {
        await chrome.tabGroups.update(current.id, {
          title: VERBOO_TAB_GROUP_TITLE,
          color: VERBOO_TAB_GROUP_COLOR,
        })
        return { groupId: current.id }
      }
    } catch {
      // Fall through to create/move.
    }
    groupId = await chrome.tabs.group({ tabIds: [tabId] })
  } else {
    groupId = await chrome.tabs.group({ tabIds: [tabId] })
  }

  await chrome.tabGroups.update(groupId, {
    title: VERBOO_TAB_GROUP_TITLE,
    color: VERBOO_TAB_GROUP_COLOR,
  })
  return { groupId }
}

// ── Viewport frame ─────────────────────────────────────────────

/**
 * Inject (or re-assert) the purple presence frame on the page.
 * Idempotent — does not double-inject.
 *
 * @param {number} tabId
 * @param {number} [generation]
 * @returns {Promise<void>}
 */
export async function showPresenceFrame(tabId, generation) {
  if (typeof tabId !== 'number') return
  await ensurePresenceGenerationReady()
  const injectionGeneration = await rememberPresenceTab(tabId)
  if (typeof generation !== 'number') generation = injectionGeneration
  if (typeof generation === 'number') {
    // Callers that coordinate multiple presence effects pass one snapshot.
    // Direct callers use the current generation captured above.
    generation = generation <= injectionGeneration ? generation : injectionGeneration
  }
  const appliedGeneration = generation
  await chrome.scripting.executeScript({
    target: { tabId },
    func: injectPresenceFrameInPage,
    args: [FRAME_ID, FRAME_STYLE_ID, appliedGeneration],
  })
  if (appliedGeneration < presenceGeneration) {
    await hidePresenceFrame(tabId, appliedGeneration).catch(() => {})
  }
}

/**
 * Remove the presence frame overlay from the page (optional end of turn).
 *
 * @param {number} tabId
 * @param {number} [maxGeneration] Remove only effects born at or below this generation.
 * @returns {Promise<void>}
 */
export async function hidePresenceFrame(tabId, maxGeneration) {
  if (typeof tabId !== 'number') return
  await chrome.scripting.executeScript({
    target: { tabId },
    func: removeByIdsInPage,
    args: [[FRAME_ID, FRAME_STYLE_ID], maxGeneration],
  })
}

// ── Agent cursor ───────────────────────────────────────────────

/**
 * Show / move the agent cursor. Accepts viewport coords or a selector
 * (centers on the element's bounding rect; scrolls into view first).
 * When target is null/omitted, places cursor near viewport center with
 * a soft entrance (so presence is always visible during control).
 *
 * @param {number} tabId
 * @param {{ x: number; y: number } | { selector: string } | null | undefined} target
 * @param {number} [generation]
 * @returns {Promise<void>}
 */
export async function showAgentCursor(tabId, target, generation) {
  if (typeof tabId !== 'number') return
  await ensurePresenceGenerationReady()
  const injectionGeneration = await rememberPresenceTab(tabId)
  if (typeof generation !== 'number') generation = injectionGeneration
  const appliedGeneration =
    typeof generation === 'number' && generation <= injectionGeneration
      ? generation
      : injectionGeneration
  const payload =
    target && typeof target === 'object'
      ? target
      : null
  await chrome.scripting.executeScript({
    target: { tabId },
    func: injectAgentCursorInPage,
    args: [CURSOR_ID, CURSOR_STYLE_ID, payload, CURSOR_MOVE_MS, appliedGeneration],
  })
  if (appliedGeneration < presenceGeneration) {
    await hideAgentCursor(tabId, appliedGeneration).catch(() => {})
  }
}

/**
 * Brief click pulse + ripple at the cursor tip (feedback before DOM click).
 *
 * @param {number} tabId
 * @param {number} [generation]
 * @returns {Promise<void>}
 */
export async function pulseAgentCursor(tabId, generation) {
  if (typeof tabId !== 'number') return
  await ensurePresenceGenerationReady()
  const injectionGeneration = await rememberPresenceTab(tabId)
  if (typeof generation !== 'number') generation = injectionGeneration
  const appliedGeneration =
    typeof generation === 'number' && generation <= injectionGeneration
      ? generation
      : injectionGeneration
  await chrome.scripting.executeScript({
    target: { tabId },
    func: pulseAgentCursorInPage,
    args: [CURSOR_ID, CURSOR_RIPPLE_ID, appliedGeneration],
  })
  if (appliedGeneration < presenceGeneration) {
    await hideAgentCursor(tabId, appliedGeneration).catch(() => {})
  }
}

/**
 * Remove the agent cursor overlay.
 *
 * @param {number} tabId
 * @param {number} [maxGeneration] Remove only effects born at or below this generation.
 * @returns {Promise<void>}
 */
export async function hideAgentCursor(tabId, maxGeneration) {
  if (typeof tabId !== 'number') return
  await chrome.scripting.executeScript({
    target: { tabId },
    func: removeByIdsInPage,
    args: [[CURSOR_ID, CURSOR_STYLE_ID, CURSOR_RIPPLE_ID], maxGeneration],
  })
}

/**
 * Hide frame + cursor on a known tab (end of agent control).
 *
 * @param {number} tabId
 * @param {number} [maxGeneration] Remove only effects born at or below this generation.
 * @returns {Promise<void>}
 */
export async function clearPresence(tabId, maxGeneration) {
  if (typeof tabId !== 'number') return
  await ensurePresenceGenerationReady()
  const removalGeneration =
    typeof maxGeneration === 'number' ? maxGeneration : (await advancePresenceGeneration()) - 1
  // Clear independently so one failure does not leave the other visible.
  try {
    await hidePresenceFrame(tabId, removalGeneration)
  } catch {
    /* ignore */
  }
  try {
    await hideAgentCursor(tabId, removalGeneration)
  } catch {
    /* ignore */
  }
}

/**
 * Best-effort clear of presence overlays. Resolves the active tab when
 * `tabId` is omitted. Never throws — presence must not block turn teardown.
 *
 * @param {number} [tabId]
 * @returns {Promise<void>}
 */
export async function clearPresenceBestEffort(tabId) {
  try {
    let id = tabId
    if (typeof id !== 'number') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      id = tab?.id
    }
    if (typeof id !== 'number') return
    await clearPresence(id)
  } catch {
    // chrome:// pages, closed tabs, missing APIs — ignore.
  }
}

/**
 * Drop only the touched entries that belonged to this cleanup snapshot.
 * A newer injection on the same tab has a newer generation and must remain
 * persisted for the next cleanup.
 *
 * @param {Map<number, number>} cleanupTouchedTabGenerations
 * @param {number} threshold
 * @returns {Promise<void>}
 */
async function forgetCleanedPresenceTabs(cleanupTouchedTabGenerations, threshold) {
  let changed = false
  for (const [tabId, generation] of cleanupTouchedTabGenerations) {
    const currentGeneration = touchedPresenceTabGenerations.get(tabId)
    if (currentGeneration === generation && generation <= threshold) {
      touchedPresenceTabGenerations.delete(tabId)
      touchedPresenceTabIds.delete(tabId)
      changed = true
    }
  }
  if (changed) await persistTouchedPresenceTabs()
}

/**
 * Clear presence overlays on every tab that could have them. Targets:
 *   - Tabs persisted when a frame or cursor was injected, across worker restarts
 *   - All tabs in any "Verboo" tab group (any window)
 *   - Plus the active tab in every window (fallback when no group exists)
 *
 * Use at turn teardown when the agent may have opened / switched tabs
 * mid-turn and we don't want a stale frame left behind on a background tab.
 *
 * Never throws — presence cleanup must not block turn teardown.
 *
 * @returns {Promise<void>}
 */
export async function clearPresenceOnAllTabs() {
  await ensurePresenceGenerationReady()
  await presenceTouchedTabGenerationsWrite
  const cleanupGenerationPromise = advancePresenceGeneration()
  /** @type {Set<number>} */
  const tabIds = new Set(touchedPresenceTabIds)
  /** @type {Map<number, number>} */
  const cleanupTouchedTabGenerations = new Map(
    Array.from(tabIds, (tabId) => [
      tabId,
      touchedPresenceTabGenerations.get(tabId) ?? Math.max(0, presenceGeneration - 1),
    ]),
  )
  try {
    try {
      const groups = await chrome.tabGroups.query({ title: VERBOO_TAB_GROUP_TITLE })
      for (const g of groups) {
        const tabs = await chrome.tabs.query({ groupId: g.id })
        for (const t of tabs) {
          if (typeof t.id === 'number') tabIds.add(t.id)
        }
      }
    } catch {
      // tabGroups may be unavailable — fall through to active-tab fallback.
    }
    try {
      const windows = await chrome.windows.getAll()
      for (const w of windows) {
        const [active] = await chrome.tabs.query({
          active: true,
          windowId: w.id,
        })
        if (typeof active?.id === 'number') tabIds.add(active.id)
      }
    } catch {
      // windows/tabs query failure — best-effort.
    }
    const cleanupGeneration = await cleanupGenerationPromise
    await Promise.all(
      Array.from(tabIds).map((id) => clearPresence(id, cleanupGeneration - 1).catch(() => {})),
    )
    await forgetCleanedPresenceTabs(
      cleanupTouchedTabGenerations,
      cleanupGeneration - 1,
    )
  } catch {
    // Whole-operation failure — ignore.
  }
}

/**
 * Frame + cursor for the whole control session (turn start / after navigate).
 * Always shows the cursor (viewport center when no target) so presence is
 * never "frame only".
 *
 * @param {number} tabId
 * @param {{ x: number; y: number } | { selector: string } | null | undefined} [target]
 * @returns {Promise<void>}
 */
export async function ensureAgentPresence(tabId, target) {
  if (typeof tabId !== 'number') return
  await ensurePresenceGenerationReady()
  const generation = await rememberPresenceTab(tabId)
  try {
    await showPresenceFrame(tabId, generation)
    await showAgentCursor(tabId, target ?? null, generation)
  } catch {
    // chrome:// pages, closed tabs, CSP — ignore.
  }
}

/**
 * Best-effort presence prelude used by click/type/read/screenshot:
 * frame + cursor (selector or center) + delay. Never throws.
 * Delay is randomBetween(840, 980) unless reduced-motion (0).
 *
 * @param {number} tabId
 * @param {string} [selector]
 * @returns {Promise<void>}
 */
export async function preparePresenceForAction(tabId, selector) {
  await ensurePresenceGenerationReady()
  const generation = typeof tabId === 'number'
    ? await rememberPresenceTab(tabId)
    : presenceGeneration
  try {
    await showPresenceFrame(tabId, generation)
    // Always animate the cursor — even without a selector (center target).
    await showAgentCursor(
      tabId,
      typeof selector === 'string' && selector ? { selector } : null,
      generation,
    )
    const delayMs = await resolvePresenceDelayMs(tabId)
    if (delayMs > 0) await sleep(delayMs)
  } catch {
    // chrome:// pages, closed tabs, CSP edge cases — ignore.
  }
}

/**
 * @param {number} tabId
 * @returns {Promise<number>} 0 when prefers-reduced-motion, else 840–980
 */
async function resolvePresenceDelayMs(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () =>
        typeof matchMedia === 'function' &&
        matchMedia('(prefers-reduced-motion: reduce)').matches,
    })
    if (r?.result) return 0
  } catch {
    // Fall through to random delay.
  }
  return randomBetween(PRESENCE_ACTION_DELAY_MS_MIN, PRESENCE_ACTION_DELAY_MS_MAX)
}

// ── In-page injectors (serialized into the page via executeScript) ──

/**
 * @param {string} frameId
 * @param {string} styleId
 * @param {number} generation
 */
function injectPresenceFrameInPage(frameId, styleId, generation) {
  const appliedGeneration = Number.isFinite(generation) ? generation : 0
  const generationText = String(appliedGeneration)
  // Must be self-contained (serialized into the page). Avoids innerHTML —
  // YouTube Trusted Types can reject string HTML injection.
  const existing = document.getElementById(frameId)
  if (existing) {
    const existingGeneration = Number(existing.dataset?.verbooPresenceGeneration)
    if (Number.isFinite(existingGeneration) && existingGeneration > appliedGeneration) return
    existing.dataset.verbooPresenceGeneration = generationText
    const existingStyle = document.getElementById(styleId)
    const styleGeneration = Number(existingStyle?.dataset?.verbooPresenceGeneration)
    if (
      existingStyle &&
      (!Number.isFinite(styleGeneration) || styleGeneration < appliedGeneration)
    ) {
      existingStyle.dataset.verbooPresenceGeneration = generationText
    }
    existing.classList.add('verboo-frame-visible')
    return
  }

  const reduced =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches

  if (!document.getElementById(styleId)) {
    const style = document.createElement('style')
    style.id = styleId
    style.dataset.verbooPresenceGeneration = generationText
    style.textContent = `
#${frameId} {
  position: fixed !important;
  inset: 0 !important;
  pointer-events: none !important;
  z-index: 2147483646 !important;
  box-shadow:
    inset 0 0 0 1px rgba(170, 113, 255, 0.72),
    inset 0 0 52px 7px rgba(147, 85, 255, 0.17),
    inset 0 0 118px 28px rgba(89, 102, 228, 0.09),
    0 0 28px 4px rgba(147, 85, 255, 0.2) !important;
  border-radius: 0 !important;
  opacity: 0;
  transition: opacity 220ms cubic-bezier(0.23, 1, 0.32, 1);
  margin: 0 !important;
  padding: 0 !important;
}
#${frameId}.verboo-frame-visible {
  opacity: 1 !important;
}
#${frameId}::before,
#${frameId}::after {
  content: "" !important;
  position: absolute !important;
  width: 48% !important;
  height: 64px !important;
  border-radius: 50% !important;
  filter: blur(18px) !important;
  opacity: 0.7;
}
#${frameId}::before {
  top: -34px !important;
  left: -20% !important;
  background: linear-gradient(90deg, transparent, rgba(92, 126, 255, 0.52), rgba(179, 102, 255, 0.72), transparent) !important;
}
#${frameId}::after {
  right: -20% !important;
  bottom: -35px !important;
  background: linear-gradient(90deg, transparent, rgba(190, 106, 255, 0.64), rgba(99, 119, 255, 0.5), transparent) !important;
}
@keyframes verboo-flow-edge-forward {
  to { transform: translateX(150%); }
}
@keyframes verboo-flow-edge-back {
  to { transform: translateX(-150%); }
}
#${frameId}.verboo-animate::before {
  animation: verboo-flow-edge-forward 6.4s ease-in-out infinite alternate;
}
#${frameId}.verboo-animate::after {
  animation: verboo-flow-edge-back 7.2s ease-in-out infinite alternate;
}
`.trim()
    ;(document.documentElement || document.body).appendChild(style)
  } else {
    const style = document.getElementById(styleId)
    const styleGeneration = Number(style?.dataset?.verbooPresenceGeneration)
    if (style && (!Number.isFinite(styleGeneration) || styleGeneration < appliedGeneration)) {
      style.dataset.verbooPresenceGeneration = generationText
    }
  }

  const frame = document.createElement('div')
  frame.id = frameId
  frame.dataset.verbooPresenceGeneration = generationText
  frame.setAttribute('aria-hidden', 'true')
  if (!reduced) frame.classList.add('verboo-animate')
  ;(document.documentElement || document.body).appendChild(frame)
  requestAnimationFrame(() => {
    const f = document.getElementById(frameId)
    if (f?.dataset?.verbooPresenceGeneration === generationText) {
      f.classList.add('verboo-frame-visible')
    }
  })
}

/**
 * @param {string} cursorId
 * @param {string} styleId
 * @param {{ x?: number; y?: number; selector?: string } | null} target
 * @param {number} moveMs
 * @param {number} generation
 */
function injectAgentCursorInPage(cursorId, styleId, target, moveMs, generation) {
  // Self-contained (serialized into the page). No outer helpers, no innerHTML
  // (YouTube Trusted Types rejects string HTML injection).
  const appliedGeneration = Number.isFinite(generation) ? generation : 0
  const generationText = String(appliedGeneration)

  function buildPointerSvg() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '30')
    svg.setAttribute('height', '30')
    svg.setAttribute('viewBox', '0 0 34 34')
    svg.setAttribute('aria-hidden', 'true')
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('fill', '#a468ff')
    path.setAttribute('stroke', '#ffffff')
    path.setAttribute('stroke-width', '1.25')
    path.setAttribute('stroke-linejoin', 'round')
    path.setAttribute('d', 'M4.4 3.8 L6.1 26.4 L12.05 20.34 L16.64 29.25 L20.64 27.19 L16.05 18.28 L24.58 17.42 Z')
    const facet = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    facet.setAttribute('fill', '#7f48eb')
    facet.setAttribute('fill-opacity', '0.52')
    facet.setAttribute('d', 'M5.25 4.7 L15.98 18.24 L11.94 20.1 L6.25 25.45 Z')
    const highlight = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    highlight.setAttribute('fill', 'none')
    highlight.setAttribute('stroke', '#ffffff')
    highlight.setAttribute('stroke-opacity', '0.5')
    highlight.setAttribute('stroke-width', '1')
    highlight.setAttribute('stroke-linecap', 'round')
    highlight.setAttribute('d', 'M7.1 7.1 L7.9 20.2')
    svg.appendChild(path)
    svg.appendChild(facet)
    svg.appendChild(highlight)
    return svg
  }

  function readCursorPosition(cursor, fallbackX, fallbackY) {
    try {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(cursor).transform)
      if (Number.isFinite(matrix.m41) && Number.isFinite(matrix.m42)) {
        return { x: matrix.m41, y: matrix.m42 }
      }
    } catch {
      /* fall through */
    }
    const storedX = Number(cursor.dataset.verbooX)
    const storedY = Number(cursor.dataset.verbooY)
    return {
      x: Number.isFinite(storedX) ? storedX : fallbackX,
      y: Number.isFinite(storedY) ? storedY : fallbackY,
    }
  }

  function glideCursor(cursor, fromX, fromY, toX, toY, duration) {
    const finalTransform = `translate(${toX}px, ${toY}px)`
    cursor.style.setProperty('--verboo-cursor-t', finalTransform)

    if (typeof cursor.animate !== 'function' || duration <= 0) {
      cursor.style.transform = finalTransform
      cursor.dataset.verbooX = String(toX)
      cursor.dataset.verbooY = String(toY)
      return
    }

    const dx = toX - fromX
    const dy = toY - fromY
    const distance = Math.hypot(dx, dy)
    const arc = Math.min(20, Math.max(8, distance * 0.035))
    const tilt = Math.max(-12, Math.min(12, dx / 30))
    const directionAngle = Math.atan2(dy, dx) * 180 / Math.PI
    const motionId = String((Number(cursor.dataset.verbooMotionId) || 0) + 1)
    cursor.dataset.verbooMotionId = motionId

    cursor.__verbooMotion?.cancel()
    cursor.style.setProperty('--verboo-flow-angle', `${directionAngle}deg`)
    cursor.classList.add('verboo-cursor-moving')
    const animation = cursor.animate(
      [
        {
          transform: `translate3d(${fromX}px, ${fromY}px, 0) rotate(0deg) scale(1)`,
        },
        {
          transform: `translate3d(${fromX + dx * 0.24}px, ${fromY + dy * 0.1 - arc}px, 0) rotate(${tilt * 0.72}deg) scale(1.025)`,
          offset: 0.25,
        },
        {
          transform: `translate3d(${fromX + dx * 0.58}px, ${fromY + dy * 0.46 - arc * 1.08}px, 0) rotate(${tilt}deg) scale(1.035)`,
          offset: 0.58,
        },
        {
          transform: `translate3d(${fromX + dx * 0.86}px, ${fromY + dy * 0.84 - arc * 0.34}px, 0) rotate(${tilt * 0.38}deg) scale(1.01)`,
          offset: 0.86,
        },
        {
          transform: `translate3d(${toX}px, ${toY}px, 0) rotate(0deg) scale(1)`,
        },
      ],
      {
        duration,
        easing: 'cubic-bezier(0.45, 0, 0.2, 1)',
        fill: 'forwards',
      },
    )
    cursor.__verbooMotion = animation

    animation.finished
      .then(() => {
        if (
          cursor.dataset.verbooMotionId !== motionId ||
          cursor.dataset.verbooPresenceGeneration !== generationText
        ) return
        cursor.style.transform = finalTransform
        cursor.dataset.verbooX = String(toX)
        cursor.dataset.verbooY = String(toY)
        cursor.classList.remove('verboo-cursor-moving')
        cursor.__verbooMotion = null
        animation.cancel()
      })
      .catch(() => {
        // A new target can supersede this movement.
      })
  }

  const reduced =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches
  const duration = reduced
    ? 0
    : Number.isFinite(moveMs) && moveMs > 0
      ? moveMs
      : 760

  let x = window.innerWidth * 0.5
  let y = window.innerHeight * 0.42

  if (target && typeof target.selector === 'string') {
    let el = null
    try {
      el = document.querySelector(target.selector)
    } catch {
      el = null
    }
    if (el) {
      try {
        el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
      } catch {
        try {
          el.scrollIntoView(true)
        } catch {
          /* ignore */
        }
      }
      const rect = el.getBoundingClientRect()
      x = rect.left + rect.width / 2
      y = rect.top + rect.height / 2
    }
  } else if (
    target &&
    typeof target.x === 'number' &&
    typeof target.y === 'number' &&
    Number.isFinite(target.x) &&
    Number.isFinite(target.y)
  ) {
    x = target.x
    y = target.y
  }

  if (!document.getElementById(styleId)) {
    const style = document.createElement('style')
    style.id = styleId
    style.dataset.verbooPresenceGeneration = generationText
    style.textContent = `
#${cursorId} {
  position: fixed !important;
  left: 0 !important;
  top: 0 !important;
  width: 34px !important;
  height: 34px !important;
  pointer-events: none !important;
  z-index: 2147483647 !important;
  opacity: 0;
  transform-origin: 0 0;
  filter:
    drop-shadow(0 2px 1px rgba(25, 17, 38, 0.3))
    drop-shadow(0 9px 17px rgba(98, 47, 174, 0.31));
  will-change: transform, opacity;
  line-height: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  background: transparent !important;
  border: none !important;
}
#${cursorId}::before {
  content: "" !important;
  position: absolute !important;
  left: 2px !important;
  top: 24px !important;
  width: 32px !important;
  height: 9px !important;
  border-radius: 50% !important;
  background: linear-gradient(90deg, rgba(147, 85, 255, 0.04), rgba(50, 27, 84, 0.3)) !important;
  filter: blur(6px) !important;
  opacity: 0.68;
  transform: scaleX(0.9);
  transform-origin: center !important;
  transition:
    opacity 180ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 180ms cubic-bezier(0.23, 1, 0.32, 1);
}
#${cursorId}::after {
  content: "" !important;
  position: absolute !important;
  left: -42px !important;
  top: 9px !important;
  width: 48px !important;
  height: 5px !important;
  border-radius: 999px !important;
  background: linear-gradient(90deg, transparent, rgba(108, 121, 255, 0.24), rgba(169, 109, 255, 0.58)) !important;
  filter: blur(2px) !important;
  opacity: 0;
  transform: rotate(var(--verboo-flow-angle, 0deg)) scaleX(0.35);
  transform-origin: 100% 50% !important;
  transition:
    opacity 180ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 180ms cubic-bezier(0.23, 1, 0.32, 1);
}
#${cursorId}.verboo-cursor-moving::before {
  opacity: 0.42;
  transform: scaleX(1.12);
}
#${cursorId}.verboo-cursor-moving::after {
  opacity: 0.62;
  transform: rotate(var(--verboo-flow-angle, 0deg)) scaleX(1);
}
#${cursorId}.verboo-cursor-visible {
  opacity: 1 !important;
}
#${cursorId} svg {
  display: block !important;
  position: relative !important;
  z-index: 1 !important;
  width: 30px !important;
  height: 30px !important;
  overflow: visible !important;
}
#${cursorId}.verboo-cursor-animate {
  transition: opacity 200ms cubic-bezier(0.23, 1, 0.32, 1);
}
#${cursorId}.verboo-cursor-click {
  transition: transform 140ms cubic-bezier(0.23, 1, 0.32, 1) !important;
  transform: var(--verboo-cursor-t) scale(0.86) !important;
}
@keyframes verboo-cursor-ripple {
  from {
    opacity: 0.65;
    transform: translate(-50%, -50%) scale(0.3);
  }
  to {
    opacity: 0;
    transform: translate(-50%, -50%) scale(1.85);
  }
}
#${cursorId}-ripple {
  position: fixed !important;
  width: 36px !important;
  height: 36px !important;
  border-radius: 50% !important;
  pointer-events: none !important;
  z-index: 2147483646 !important;
  border: 2px solid rgba(147, 85, 255, 0.85) !important;
  background: rgba(147, 85, 255, 0.22) !important;
  animation: verboo-cursor-ripple 480ms cubic-bezier(0.23, 1, 0.32, 1) forwards;
  margin: 0 !important;
  padding: 0 !important;
}
`.trim()
    ;(document.documentElement || document.body).appendChild(style)
  } else {
    const style = document.getElementById(styleId)
    const styleGeneration = Number(style?.dataset?.verbooPresenceGeneration)
    if (style && (!Number.isFinite(styleGeneration) || styleGeneration < appliedGeneration)) {
      style.dataset.verbooPresenceGeneration = generationText
    }
  }

  let cursor = document.getElementById(cursorId)
  if (cursor) {
    const cursorGeneration = Number(cursor.dataset?.verbooPresenceGeneration)
    if (Number.isFinite(cursorGeneration) && cursorGeneration > appliedGeneration) return
    cursor.dataset.verbooPresenceGeneration = generationText
  }
  const transform = `translate(${x}px, ${y}px)`

  if (!cursor) {
    cursor = document.createElement('div')
    cursor.id = cursorId
    cursor.dataset.verbooPresenceGeneration = generationText
    cursor.setAttribute('aria-hidden', 'true')
    cursor.appendChild(buildPointerSvg())
    const enterX = Math.max(0, x - 36)
    const enterY = Math.max(0, y - 24)
    cursor.style.transform = `translate(${enterX}px, ${enterY}px)`
    cursor.dataset.verbooX = String(enterX)
    cursor.dataset.verbooY = String(enterY)
    cursor.style.setProperty('--verboo-cursor-t', transform)
    ;(document.documentElement || document.body).appendChild(cursor)
    if (!reduced) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const c = document.getElementById(cursorId)
          if (!c || c.dataset.verbooPresenceGeneration !== generationText) return
          c.classList.add('verboo-cursor-animate', 'verboo-cursor-visible')
          glideCursor(c, enterX, enterY, x, y, duration)
        })
      })
    } else {
      cursor.classList.add('verboo-cursor-visible')
      cursor.style.transform = transform
      cursor.dataset.verbooX = String(x)
      cursor.dataset.verbooY = String(y)
    }
  } else {
    if (!cursor.querySelector('svg')) {
      while (cursor.firstChild) cursor.removeChild(cursor.firstChild)
      cursor.appendChild(buildPointerSvg())
    }
    cursor.classList.remove('verboo-cursor-idle', 'verboo-cursor-click')
    if (reduced) {
      cursor.__verbooMotion?.cancel()
      cursor.__verbooMotion = null
      cursor.classList.remove('verboo-cursor-moving')
      cursor.classList.remove('verboo-cursor-animate')
      cursor.classList.add('verboo-cursor-visible')
      cursor.style.transform = transform
      cursor.dataset.verbooX = String(x)
      cursor.dataset.verbooY = String(y)
    } else {
      cursor.classList.add('verboo-cursor-animate', 'verboo-cursor-visible')
      const from = readCursorPosition(cursor, x, y)
      glideCursor(cursor, from.x, from.y, x, y, duration)
    }
    cursor.style.setProperty('--verboo-cursor-t', transform)
  }
}

/**
 * @param {string} cursorId
 * @param {string} rippleId
 * @param {number} generation
 */
function pulseAgentCursorInPage(cursorId, rippleId, generation) {
  const appliedGeneration = Number.isFinite(generation) ? generation : 0
  const generationText = String(appliedGeneration)
  const cursor = document.getElementById(cursorId)
  if (!cursor) return
  const cursorGeneration = Number(cursor.dataset?.verbooPresenceGeneration)
  if (Number.isFinite(cursorGeneration) && cursorGeneration > appliedGeneration) return
  cursor.dataset.verbooPresenceGeneration = generationText

  const reduced =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches

  const m = /translate\(\s*([-\d.]+)px\s*,\s*([-\d.]+)px\s*\)/.exec(
    cursor.style.transform || '',
  )
  const x = m ? Number(m[1]) : window.innerWidth / 2
  const y = m ? Number(m[2]) : window.innerHeight / 2
  const base = `translate(${x}px, ${y}px)`
  cursor.style.setProperty('--verboo-cursor-t', base)

  if (!reduced) {
    cursor.classList.remove('verboo-cursor-idle')
    cursor.classList.add('verboo-cursor-click')
    setTimeout(() => {
      const c = document.getElementById(cursorId)
      if (!c || c.dataset.verbooPresenceGeneration !== generationText) return
      c.classList.remove('verboo-cursor-click')
      c.style.transform = base
      c.classList.add('verboo-cursor-idle')
    }, 160)
  }

  document.getElementById(rippleId)?.remove()
  if (reduced) return
  const ripple = document.createElement('div')
  ripple.id = rippleId
  ripple.dataset.verbooPresenceGeneration = generationText
  ripple.setAttribute('aria-hidden', 'true')
  ripple.style.left = `${x}px`
  ripple.style.top = `${y}px`
  ;(document.documentElement || document.body).appendChild(ripple)
  setTimeout(() => {
    const current = document.getElementById(rippleId)
    if (current?.dataset?.verbooPresenceGeneration === generationText) current.remove()
  }, 500)
}

/**
 * @param {string[]} ids
 * @param {number} [maxGeneration]
 */
function removeByIdsInPage(ids, maxGeneration) {
  const threshold = Number(maxGeneration)
  const removedIds = []
  for (const id of ids) {
    const element = document.getElementById(id)
    if (!element) continue
    const elementGeneration = Number(element.dataset?.verbooPresenceGeneration)
    if (
      !Number.isFinite(threshold) ||
      !Number.isFinite(elementGeneration) ||
      elementGeneration <= threshold
    ) {
      element.remove()
      removedIds.push(id)
    }
  }
  return removedIds
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
