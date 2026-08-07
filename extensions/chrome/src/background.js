/**
 * background.js — Verboo Chrome Extension service worker.
 *
 * Responsibilities:
 * - P1: Open side panel on toolbar icon click
 * - P2: Message handler for Browser Tool calls + agent turn loop.
 *       Every tool call passes through execute() → evaluateToolPolicy
 *       before any chrome.* API is touched.
 *
 * Standalone agent client; MCP bridge is added only with a packaged host.
 *
 * Multi-user: zero hardcoded accounts.
 */

import { executeWithApproval } from './controller/approvedExecute.js'
import { loadMode } from './policy/modesStore.js'
import { getGrant, upsertGrant } from './policy/siteGrantsStore.js'
import { MSG } from './controller/protocol.js'
import {
  ensureFreshSession,
  loadSession,
  logout,
  refreshSession,
  startOAuthLogin,
  getAuthCapabilities,
  loadModels,
  selectModel,
  getSelectedModelId,
  resolveModelSelection,
} from './auth/auth.js'
import {
  ensureVerbooTabGroup,
  ensureAgentPresence,
  clearPresenceOnAllTabs,
  disableGlobalVerbooPanel,
  openVerbooPanel,
  openVerbooWorkspace,
} from './presence/inject.js'
import {
  SELECTION_CONTEXT_MENU_ID,
  createSelectionContextController,
  installSelectionContextMenu,
  readSelectionFromPage,
} from './selectionContext.js'
import {
  runLlmAgentTurn,
  requiresScreenshot,
  shouldOfferBrowserTools,
  summarizePartialAgentTurn,
} from './agent/loop.js'
import { createNativeBridge } from './native/bridge.js'
import { chatCompletion } from './agent/routerClient.js'
import { createRoutinesStore } from './routines/store.js'
import { createRoutineMessageHandler } from './routines/messageHandler.js'
import { createRunQueue } from './routines/runQueue.js'
import { createRunStore } from './routines/runStore.js'
import { createRoutineRunner } from './routines/runner.js'
import { buildConversationDraft, buildPromptDraft } from './routines/draftBuilder.js'
import { createAssetsStore } from './routines/assetsStore.js'
import { createTemporaryDraftStore } from './routines/temporaryDraftStore.js'
import { createRecordingController } from './routines/recording/controller.js'
import { createScheduler } from './routines/scheduler.js'
import { applyRecoverySuggestion } from './routines/recoverySuggestion.js'

const ROUTINE_MESSAGE_TYPES = new Set([
  MSG.ROUTINE_LIST,
  MSG.ROUTINE_GET,
  MSG.ROUTINE_CREATE,
  MSG.ROUTINE_UPDATE,
  MSG.ROUTINE_DUPLICATE,
  MSG.ROUTINE_DELETE,
])

const alarmsApi = chrome.alarms ?? {
  create() {
    throw new Error('routine_scheduling_unavailable')
  },
  clear: async () => false,
}

const routinesStore = createRoutinesStore(chrome.storage.local)
const routineAssetsStore = createAssetsStore()
const temporaryDraftStore = createTemporaryDraftStore(
  chrome.storage.session ?? chrome.storage.local,
)
const recordingController = createRecordingController({
  storage: chrome.storage.session ?? chrome.storage.local,
  sendToTab: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
  onState: (state) => broadcast({
    type: MSG.ROUTINE_RECORD_STATE_CHANGED,
    state,
  }),
})
const selectionContextController = createSelectionContextController({
  storage: chrome.storage.session ?? chrome.storage.local,
  openPanel: openVerbooPanel,
  readSelection: readSelectionFromPage,
  broadcast,
})
let routineScheduler
const routineMessageHandler = createRoutineMessageHandler({
  store: routinesStore,
  loadSession,
  broadcast,
  removeRoutineAssets: (accountId, routineId) =>
    routineAssetsStore.removeRoutineAssets(accountId, routineId),
  onRoutineChanged: async (routine, change) => {
    const updated = await routineScheduler?.reconcileRoutine(routine, change) ?? routine
    broadcast({
      type: MSG.ROUTINE_SCHEDULE_CHANGED,
      change,
      routine: updated,
    })
    return updated
  },
})
const browserControlQueue = createRunQueue()
const routineRunStore = createRunStore(chrome.storage.local)
const routineRunner = createRoutineRunner({
  routinesStore,
  runStore: routineRunStore,
  queue: browserControlQueue,
  loadSession,
  loadModels,
  getSelectedModelId,
  getActiveTabMeta: queryActiveTabMeta,
  executeRecordedStep: (toolCall, request, signal) => executeWithApproval(
    toolCall,
    () => makeExecutionContext(
      request?.senderTabId,
      request?.runId,
      request?.routineAllowedOrigins,
    ),
    makeApprovalUi(request?.runId, signal),
  ),
  runAgent: (input) => {
    const runMcpAgentTurn = (overrides) => runLlmAgentTurn({
      ...input,
      ...overrides,
      broadcast,
      executeTool: (toolCall) => executeWithApproval(
        toolCall,
        () => makeExecutionContext(
          input.senderTabId,
          input.turnId,
          input.routineAllowedOrigins,
        ),
        makeApprovalUi(input.turnId, input.signal),
      ),
      getActiveTabMeta: queryActiveTabMeta,
      refreshAccessToken: async () => {
        const refreshed = await refreshSession()
        return refreshed?.accessToken ?? null
      },
    })
    return runMcpAgentTurn({}).then((result) => {
      // Defensive: routines always run with browser tools, so a reclassify
      // signal should never surface here — but if it does, re-run with the
      // tools forced (the routine runner owns its own serialization).
      if (result?.reclassify === true) return runMcpAgentTurn({ forceBrowserTools: true })
      return result
    })
  },
  assetsStore: routineAssetsStore,
  broadcast,
})
routineScheduler = createScheduler({
  routinesStore,
  loadSession,
  ensureFreshSession,
  getSelectedModelId,
  loadModels,
  getNormalWindow: queryNormalWindow,
  createRunTab: createScheduledRoutineTab,
  runRoutine: (request) => routineRunner.run(request),
  occurrenceExists: async (accountId, key) =>
    (await routineRunStore.list(accountId)).some((run) => run.occurrenceKey === key),
  loadMode,
  getSiteGrant: getGrant,
  alarms: alarmsApi,
  notify: notifyRoutinePaused,
})

const approvalSurfaces = new Set()
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'verboo-approval-surface') return
  approvalSurfaces.add(port)
  port.onDisconnect.addListener(() => approvalSurfaces.delete(port))
})

const nativeBridge = createNativeBridge({
  executeWithApproval,
  contextFactory: () => makeExecutionContext(undefined, undefined),
  approvalUiFactory: () => makeApprovalUi(undefined, new AbortController().signal, 'native'),
  isApprovalUiAvailable: () => approvalSurfaces.size > 0,
  cancelPendingApprovals: () => cancelPendingApprovals('native'),
  clearPresenceOnAllTabs,
})
nativeBridge.registerStartup()
nativeBridge.connect()

void disableGlobalVerbooPanel().catch((error) => {
  console.warn('[Verboo] Could not disable the global side panel:', error)
})

// ── Open side panel on toolbar click ──────────────────────────────
chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.id) {
    try {
      await openVerbooWorkspace(tab.id)
    } catch (error) {
      console.error('[Verboo] Could not open the tab workspace:', error)
    }
  }
})

// ── Extension install / update ────────────────────────────────────
chrome.runtime.onInstalled.addListener((details) => {
  void installSelectionContextMenu().catch((error) => {
    console.error('[Verboo] Could not install the selected-text menu:', error)
  })
  if (details.reason === 'install') {
    console.log('[Verboo] Extension installed. Opening side panel on next toolbar click.')
  }
  void restoreRoutineExecutionState()
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info?.menuItemId !== SELECTION_CONTEXT_MENU_ID) return
  // `handleContextMenuClick` invokes sidePanel.open before its first await.
  void selectionContextController.handleContextMenuClick(info, tab).catch((error) => {
    console.error('[Verboo] Could not capture the selected-text context:', error)
  })
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    void recordingController.reinject(tabId)
  }
})

chrome.runtime.onStartup.addListener(() => {
  void restoreRoutineExecutionState()
})

chrome.alarms?.onAlarm?.addListener((alarm) => {
  void routineScheduler.handleAlarm(alarm).catch((error) => {
    console.error('[Verboo] Scheduled routine failed:', error)
  })
})

chrome.notifications?.onClicked?.addListener((notificationId) => {
  if (!notificationId.startsWith('verboo-routine:')) return
  void openRoutineNotification()
})

void restoreRoutineExecutionState()

// ── Pending approvals (toolCallId → resolver) ────────────────────
/** @type {Map<string, { resolve: (grant: 'once'|'always'|'deny'|'cancelled') => void }>} */
const pendingApprovals = new Map()

// ── Message router ────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false

  if (ROUTINE_MESSAGE_TYPES.has(message.type)) {
    routineMessageHandler(message)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ ok: false, error: error?.message ?? String(error) })
      })
    return true
  }

  switch (message.type) {
    case MSG.AGENT_TURN_START: {
      resolveSelectionContextForTurn(message)
        .then((selectionContext) => {
          // runAgentTurn always emits COMPLETE or ERROR in finally; this catch is
          // a last-resort if the function itself rejects before that path runs.
          const senderTabId = selectionContext?.tabId ?? sender.tab?.id
          const executeTurn = () => runAgentTurn(
            message.turnId,
            message.userMessage,
            senderTabId,
            message.modelId,
            message.conversationHistory,
            selectionContext,
          )
          const turnPromise = shouldOfferBrowserTools(message.userMessage)
            ? browserControlQueue.enqueue({
                id: message.turnId,
                execute: executeTurn,
                cancel: () => abortTurnController(message.turnId),
              })
            : executeTurn()
          void turnPromise
            .catch((err) => {
              try {
                void clearPresenceOnAllTabs()
              } catch {
                /* presence cleanup is best-effort */
              }
              broadcast({
                type: MSG.AGENT_TURN_ERROR,
                turnId: message.turnId,
                error: err?.message ?? String(err),
              })
            })
          sendResponse({ ok: true })
        })
        .catch((error) => {
          const reason = error?.message ?? String(error)
          console.warn('[Verboo] Rejected selected-text context for agent turn:', reason)
          sendResponse({ ok: false, error: reason })
        })
      return true
    }

    case MSG.SELECTION_CONTEXT_GET: {
      if (!Number.isInteger(message.tabId)) {
        console.warn('[Verboo] Rejected selection-context request: missing tabId')
        sendResponse({ ok: false, error: 'invalid_selection_context_request' })
        return false
      }
      selectionContextController.getPendingSelectionContext(message.tabId)
        .then((context) => sendResponse({ ok: true, context }))
        .catch((error) => {
          const reason = error?.message ?? String(error)
          console.warn('[Verboo] Could not load the selected-text context:', reason)
          sendResponse({ ok: false, error: reason })
        })
      return true
    }

    case MSG.SELECTION_CONTEXT_DISCARD: {
      if (!Number.isInteger(message.tabId) || typeof message.selectionContextId !== 'string') {
        console.warn('[Verboo] Rejected selection-context discard: invalid envelope')
        sendResponse({ ok: false, error: 'invalid_selection_context_discard' })
        return false
      }
      selectionContextController.discardPendingSelectionContext(
        message.tabId,
        message.selectionContextId,
      )
        .then((discarded) => sendResponse({ ok: true, discarded }))
        .catch((error) => {
          const reason = error?.message ?? String(error)
          console.warn('[Verboo] Could not discard the selected-text context:', reason)
          sendResponse({ ok: false, error: reason })
        })
      return true
    }

    case MSG.AGENT_TURN_CANCEL: {
      cancelTurn(message.turnId)
      sendResponse({ ok: true })
      return false
    }

    case MSG.TOOL_PENDING_LIST: {
      const approvals = [...pendingApprovals.values()]
        .filter((pending) => pending.toolCall)
        .map((pending) => ({
          ...(pending.turnId ? { turnId: pending.turnId } : {}),
          toolCall: pending.toolCall,
          policyDecision: pending.policy,
        }))
      sendResponse({ ok: true, approvals })
      return false
    }

    case MSG.ROUTINE_RUN: {
      routineRunner.run({
        ...message,
        senderTabId: sender.tab?.id,
        waitForCompletion: false,
      })
        .then((run) => sendResponse({ ok: true, run }))
        .catch((error) => {
          sendResponse({ ok: false, error: error?.message ?? String(error) })
        })
      return true
    }

    case MSG.ROUTINE_SIMULATE: {
      routineRunner.run({
        ...message,
        simulate: true,
        senderTabId: sender.tab?.id,
        waitForCompletion: false,
      })
        .then((run) => sendResponse({ ok: true, run }))
        .catch((error) => {
          sendResponse({ ok: false, error: error?.message ?? String(error) })
        })
      return true
    }

    case MSG.ROUTINE_PAUSE: {
      loadSession()
        .then(async (session) => {
          if (!session?.accountId) {
            sendResponse({ ok: false, error: 'auth_required' })
            return
          }
          const paused = await routineRunner.pause(session.accountId, message.runId)
          sendResponse({ ok: true, paused })
        })
        .catch((error) => {
          sendResponse({ ok: false, error: error?.message ?? String(error) })
        })
      return true
    }

    case MSG.ROUTINE_RESUME: {
      loadSession()
        .then(async (session) => {
          if (!session?.accountId) {
            sendResponse({ ok: false, error: 'auth_required' })
            return
          }
          const run = await routineRunner.resume(session.accountId, message.runId, {
            senderTabId: sender.tab?.id,
            waitForCompletion: false,
          })
          sendResponse({ ok: true, run })
        })
        .catch((error) => {
          sendResponse({ ok: false, error: error?.message ?? String(error) })
        })
      return true
    }

    case MSG.ROUTINE_CANCEL: {
      loadSession()
        .then(async (session) => {
          if (!session?.accountId) {
            sendResponse({ ok: false, error: 'auth_required' })
            return
          }
          const cancelled = await routineRunner.cancel(session.accountId, message.runId)
          sendResponse({ ok: true, cancelled })
        })
        .catch((error) => {
          sendResponse({ ok: false, error: error?.message ?? String(error) })
        })
      return true
    }

    case MSG.ROUTINE_RUN_LIST: {
      listRoutineRuns()
        .then((runs) => sendResponse({ ok: true, runs }))
        .catch((error) => {
          sendResponse({ ok: false, error: error?.message ?? String(error) })
        })
      return true
    }

    case MSG.ROUTINE_RECOVERY_APPLY: {
      applyRoutineRecoverySuggestion(message.runId)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => {
          sendResponse({ ok: false, error: error?.message ?? String(error) })
        })
      return true
    }

    case MSG.ROUTINE_SCHEDULE_UPSERT: {
      updateRoutineSchedule(message, false)
        .then((routine) => sendResponse({ ok: true, routine }))
        .catch((error) => {
          sendResponse({ ok: false, error: error?.message ?? String(error) })
        })
      return true
    }

    case MSG.ROUTINE_SCHEDULE_REMOVE: {
      updateRoutineSchedule(message, true)
        .then((routine) => sendResponse({ ok: true, routine }))
        .catch((error) => {
          sendResponse({ ok: false, error: error?.message ?? String(error) })
        })
      return true
    }

    case MSG.ROUTINE_DRAFT_FROM_MESSAGE: {
      createTemporaryDraftFromMessage(message.text)
        .then(({ entry }) => {
          sendResponse({ ok: true, draftId: entry.id, draft: entry.draft })
        })
        .catch((error) => {
          sendResponse({ ok: false, error: error?.message ?? String(error) })
        })
      return true
    }

    case MSG.ROUTINE_DRAFT_FROM_CONVERSATION: {
      createTemporaryDraftFromConversation(message.history)
        .then(({ entry }) => {
          sendResponse({ ok: true, draftId: entry.id, draft: entry.draft })
        })
        .catch((error) => {
          sendResponse({ ok: false, error: error?.message ?? String(error) })
        })
      return true
    }

    case MSG.ROUTINE_DRAFT_GET: {
      loadSession()
        .then(async (session) => {
          if (!session?.accountId) {
            sendResponse({ ok: false, error: 'auth_required' })
            return
          }
          const draft = await temporaryDraftStore.get(session.accountId, message.draftId)
          sendResponse(draft
            ? { ok: true, draft }
            : { ok: false, error: 'routine_draft_not_found' })
        })
        .catch((error) => {
          sendResponse({ ok: false, error: error?.message ?? String(error) })
        })
      return true
    }

    case MSG.ROUTINE_ASSET_ADD: {
      addRoutineAsset(message)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => {
          sendResponse({ ok: false, error: error?.message ?? String(error) })
        })
      return true
    }

    case MSG.ROUTINE_ASSET_DELETE: {
      removeRoutineAsset(message)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => {
          sendResponse({ ok: false, error: error?.message ?? String(error) })
        })
      return true
    }

    case MSG.ROUTINE_RECORD_START: {
      startRoutineRecording(sender.tab?.id)
        .then((state) => sendResponse({ ok: true, state }))
        .catch((error) => {
          sendResponse({ ok: false, error: error?.message ?? String(error) })
        })
      return true
    }

    case MSG.ROUTINE_RECORD_STOP: {
      stopRoutineRecording()
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => {
          sendResponse({ ok: false, error: error?.message ?? String(error) })
        })
      return true
    }

    case MSG.ROUTINE_RECORD_CANCEL: {
      cancelRoutineRecording()
        .then((cancelled) => sendResponse({ ok: true, cancelled }))
        .catch((error) => {
          sendResponse({ ok: false, error: error?.message ?? String(error) })
        })
      return true
    }

    case MSG.ROUTINE_RECORD_STATE_REQUEST: {
      recordingController.state()
        .then((state) => sendResponse({
          ok: true,
          state: state ? {
            active: true,
            id: state.id,
            tabId: state.tabId,
            startedAt: state.startedAt,
            eventCount: state.events?.length ?? 0,
          } : { active: false },
        }))
        .catch((error) => {
          sendResponse({ ok: false, error: error?.message ?? String(error) })
        })
      return true
    }

    case MSG.ROUTINE_RECORD_EVENT: {
      recordingController.recordEvent(sender.tab?.id, message.event)
        .then((accepted) => sendResponse({ ok: true, accepted }))
        .catch((error) => {
          sendResponse({ ok: false, error: error?.message ?? String(error) })
        })
      return true
    }

    case MSG.TOOL_APPROVE: {
      const pending = pendingApprovals.get(message.toolCallId)
      if (pending) {
        pending.resolve(message.decision === 'always' ? 'always' : 'once')
        pendingApprovals.delete(message.toolCallId)
      }
      sendResponse({ ok: true })
      return false
    }

    case MSG.TOOL_DENY: {
      const pending = pendingApprovals.get(message.toolCallId)
      if (pending) {
        pending.resolve('deny')
        pendingApprovals.delete(message.toolCallId)
      }
      sendResponse({ ok: true })
      return false
    }

    case 'browserTool': {
      handleBrowserTool(message.tool)
        .then(sendResponse)
        .catch((err) => {
          sendResponse({
            ok: false,
            error: err?.message ?? String(err),
            policy: { allowed: false, needsApproval: false, reason: 'handler_exception' },
          })
        })
      return true
    }

    case MSG.AUTH_LOGIN: {
      startOAuthLogin()
        .then(async (session) => {
          const models = await loadModels(true)
          const selectedId = await getSelectedModelId()
          broadcast({ type: MSG.AUTH_STATE_CHANGED, session })
          broadcast({
            type: MSG.MODELS_STATE_CHANGED,
            models,
            selectedId: selectedId ?? undefined,
          })
          await routineScheduler.syncAccount(session.accountId)
          await recoverInterruptedRoutines(session.accountId)
          sendResponse({ ok: true, session, models, selectedId })
        })
        .catch((err) => {
          sendResponse({ ok: false, error: err?.message ?? String(err) })
        })
      return true // async sendResponse
    }

    case MSG.AUTH_LOGOUT: {
      loadSession()
        .then(async (session) => {
          if (session?.accountId) {
            await routineScheduler.suspendAccount(session.accountId)
          }
          await logout()
        })
        .then(async () => {
          broadcast({ type: MSG.AUTH_STATE_CHANGED, session: null })
          broadcast({ type: MSG.MODELS_STATE_CHANGED, models: [], selectedId: undefined })
          sendResponse({ ok: true })
        })
        .catch((err) => {
          sendResponse({ ok: false, error: err?.message ?? String(err) })
        })
      return true
    }

    case MSG.AUTH_REFRESH: {
      ensureFreshSession()
        .then((session) => {
          broadcast({ type: MSG.AUTH_STATE_CHANGED, session })
          sendResponse({ ok: Boolean(session), session })
        })
        .catch((err) => {
          broadcast({ type: MSG.AUTH_STATE_CHANGED, session: null })
          sendResponse({ ok: false, session: null, error: err?.message ?? String(err) })
        })
      return true
    }

    case MSG.AUTH_STATE_REQUEST: {
      ensureFreshSession()
        .then(async (session) => {
          broadcast({ type: MSG.AUTH_STATE_CHANGED, session })
          sendResponse({ ok: true, session, capabilities: getAuthCapabilities() })
        })
        .catch((err) => {
          sendResponse({ ok: false, error: err?.message ?? String(err) })
        })
      return true
    }

    case MSG.MODELS_LIST: {
      const forceRefresh = message.forceRefresh === true
      loadModels(forceRefresh)
        .then(async (models) => {
          const selectedId = await getSelectedModelId()
          broadcast({
            type: MSG.MODELS_STATE_CHANGED,
            models,
            selectedId: selectedId ?? undefined,
          })
          sendResponse({ ok: true, models, selectedId })
        })
        .catch((err) => {
          sendResponse({ ok: false, error: err?.message ?? String(err) })
        })
      return true
    }

    case MSG.MODELS_SELECT: {
      const modelId = message.modelId
      selectModel(modelId)
        .then(async () => {
          const models = await loadModels(false)
          const selectedId = await getSelectedModelId()
          broadcast({
            type: MSG.MODELS_STATE_CHANGED,
            models,
            selectedId: selectedId ?? undefined,
          })
          sendResponse({ ok: true, selectedId })
        })
        .catch((err) => {
          sendResponse({ ok: false, error: err?.message ?? String(err) })
        })
      return true
    }

    default:
      return false
  }
})

/**
 * @param {import('./controller/execute.js').ToolCall} toolCall
 * @returns {Promise<import('./controller/execute.js').ExecutionResult>}
 */
async function handleBrowserTool(toolCall) {
  const controller = new AbortController()
  return executeWithApproval(
    toolCall,
    () => makeExecutionContext(undefined, undefined),
    makeApprovalUi(undefined, controller.signal),
  )
}

// ── Agent loop ────────────────────────────────────────────────────
//
// Flow per turn:
//   1. AGENT_TURN_STARTED
//   2. AGENT_THOUGHT (planning)
//   3. for each planned tool:
//        - run policy gate via execute()
//        - if hard_block / site_denied → AGENT_TOOL_REQUEST (with
//          policyDecision) + AGENT_TOOL_RESULT (error)
//        - if needsApproval → AGENT_TOOL_REQUEST → wait for
//          TOOL_APPROVE/DENY → if 'always' upgrade grant →
//          AGENT_TOOL_EXECUTING → AGENT_TOOL_RESULT
//        - if allowed → AGENT_TOOL_EXECUTING → AGENT_TOOL_RESULT
//   4. AGENT_TURN_COMPLETE (assistant summary)

/** @type {Map<string, AbortController>} */
const turnControllers = new Map()

/**
 * Strip heavy tool payloads (screenshots, full page text) before broadcast.
 * Large chrome.runtime messages can fail silently and leave the panel on Working…
 * @param {unknown} results
 * @returns {Array<object>}
 */
function slimToolResultsForBroadcast(results) {
  if (!Array.isArray(results)) return []
  return results.map((r) => {
    if (!r || typeof r !== 'object') return r
    const row = /** @type {Record<string, unknown>} */ (r)
    return {
      toolCallId: row.toolCallId,
      success: row.success,
      error: row.error ?? null,
      durationMs: row.durationMs ?? 0,
    }
  })
}

/**
 * Consume a panel-owned context only once. A malformed or stale envelope is
 * rejected explicitly so a selected excerpt can never disappear silently.
 *
 * @param {Record<string, unknown>} message
 * @returns {Promise<import('./selectionContext.js').PendingSelectionContext | null>}
 */
async function resolveSelectionContextForTurn(message) {
  const hasId = typeof message.selectionContextId === 'string' && message.selectionContextId
  const hasTabId = Number.isInteger(message.selectionContextTabId)
  if (!hasId && !hasTabId) return null
  if (!hasId || !hasTabId) throw new Error('invalid_selection_context_envelope')

  const context = await selectionContextController.consumePendingSelectionContext(
    message.selectionContextTabId,
    message.selectionContextId,
  )
  if (!context) throw new Error('selection_context_unavailable')
  return context
}

/**
 * @param {string} turnId
 * @param {string} userMessage
 * @param {number} [senderTabId]
 * @param {string} [requestedModelId]
 * @param {Array<object>} [conversationHistory]
 * @param {import('./selectionContext.js').PendingSelectionContext | null} [selectionContext]
 */
async function runAgentTurn(
  turnId,
  userMessage,
  senderTabId,
  requestedModelId,
  conversationHistory,
  selectionContext,
) {
  const controller = new AbortController()
  turnControllers.set(turnId, controller)
  const browserToolsRequested = shouldOfferBrowserTools(userMessage)

  // MV3 service workers can suspend mid-fetch; frozen timers then never fire the
  // router 60s abort, and the panel never gets COMPLETE/ERROR → permanent Working…
  // Periodic chrome API touch keeps the worker alive for the duration of the turn.
  const keepAliveId = setInterval(() => {
    try {
      chrome.runtime.getPlatformInfo(() => {})
    } catch {
      /* ignore */
    }
  }, 20_000)

  /** @type {boolean} */
  let terminalSent = false
  /**
   * Emit at most one COMPLETE or ERROR so the panel always leaves Working…
   * @param {object} msg
   */
  const sendTerminal = (msg) => {
    if (terminalSent) return
    terminalSent = true
    broadcast(msg)
  }

  try {
    broadcast({ type: MSG.AGENT_TURN_STARTED, turnId, userMessage })

    // Resolve the active tab up front so the model can decide between
    // a navigate (e.g. "abra o youtube" on chrome://extensions) and a
    // read_page on the current tab.
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
    // Run the real multi-step agent only when a current session and model exist.
    const session = await ensureFreshSession()
    const accessToken = session?.accessToken
    const storedModelId = await getSelectedModelId()
    let models = []
    if (accessToken) {
      try {
        models = await loadModels(false)
      } catch {
        // A cached/stored selection can still run if the catalog refresh fails.
      }
    }
    const selectedModel = resolveModelSelection(models, requestedModelId, storedModelId)
    const selectedModelId = selectedModel?.id ?? (
      models.length === 0 && typeof requestedModelId === 'string' && requestedModelId
        ? requestedModelId
        : storedModelId
    )
    const modelSupportsVision = selectedModel?.supportsVision === true

    if (browserToolsRequested && selectedModel?.supportsTools === false) {
      sendTerminal({
        type: MSG.AGENT_TURN_ERROR,
        turnId,
        error: browserAgentErrorMessage(userMessage, 'model_tool_protocol_unsupported'),
      })
      return
    }

    if (requiresScreenshot(userMessage) && !modelSupportsVision) {
      sendTerminal({
        type: MSG.AGENT_TURN_ERROR,
        turnId,
        error: browserAgentErrorMessage(userMessage, 'screenshot_requires_visual_model'),
      })
      return
    }

    // Agent presence: purple Verboo tab group + viewport frame while we control.
    // Presence is UX chrome — not a BrowserTool — so it does not go through
    // execute()/evaluateToolPolicy. Failures (chrome:// etc.) are ignored.
    const presenceTabId = activeTab?.id ?? senderTabId
    if (browserToolsRequested && typeof presenceTabId === 'number') {
      try {
        await ensureVerbooTabGroup(presenceTabId)
        // Frame + animated cursor from the first moment of control.
        await ensureAgentPresence(presenceTabId)
      } catch {
        // Non-controllable page or missing APIs — continue the turn.
      }
    }

    if (accessToken && selectedModelId) {
      try {
        const llmOptions = () => ({
          turnId,
          userMessage,
          accessToken,
          modelId: selectedModelId,
          modelSupportsVision,
          conversationHistory,
          selectionContext,
          broadcast: (msg) => broadcast(msg),
          executeTool: (tc) => executeWithApproval(
            tc,
            () => makeExecutionContext(senderTabId, turnId),
            makeApprovalUi(turnId, controller.signal),
          ),
          getActiveTabMeta: async () => {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
            return { url: tab?.url, title: tab?.title, id: tab?.id }
          },
          refreshAccessToken: async () => {
            const refreshed = await refreshSession()
            return refreshed?.accessToken ?? null
          },
          signal: controller.signal,
        })
        const llmResult = await runLlmAgentTurn(llmOptions())
        // B2-CHROME reclassification: when the model emitted a browser tool
        // call in a turn the classifier labeled as conversation, the loop
        // returns { reclassify: true } instead of running the tool inline.
        // Re-run the turn WITH the tools available, routed through the
        // browserControlQueue so browser actions stay serialized across
        // concurrent turns (two turns must never interleave actions on the
        // user's browser).
        //
        // Queue ownership: the reclassified turn was classified as
        // conversation at background.js:281, so it does NOT currently hold
        // the queue. Still, defensively check activeId(): if this turn ever
        // runs while holding the queue, enqueuing the re-run would deadlock
        // (it would wait for itself) — in that case re-run inline instead.
        let finalResult = llmResult
        if (llmResult?.reclassify === true) {
          const reclassifyTurn = () => runLlmAgentTurn({ ...llmOptions(), forceBrowserTools: true })
          const ownsQueue = browserControlQueue.activeId() === turnId
          finalResult = ownsQueue
            ? await reclassifyTurn()
            : await browserControlQueue.enqueue({
                id: `${turnId}:reclassify`,
                execute: reclassifyTurn,
                cancel: () => abortTurnController(turnId),
              })
        }
        sendTerminal({
          type: MSG.AGENT_TURN_COMPLETE,
          turnId,
          assistantMessage: finalResult.assistantMessage ?? 'Done.',
          toolResults: slimToolResultsForBroadcast(finalResult.toolResults),
        })
        return
      } catch (llmErr) {
        if (controller.signal.aborted) {
          sendTerminal({
            type: MSG.AGENT_TURN_ERROR,
            turnId,
            error: 'cancelled',
          })
          return
        }
        // Partial progress attached on some errors (defensive).
        const partial = llmErr?.partialToolResults
        if (Array.isArray(partial) && partial.length > 0) {
          sendTerminal({
            type: MSG.AGENT_TURN_COMPLETE,
            turnId,
            assistantMessage: summarizePartialAgentTurn(userMessage, partial),
            toolResults: slimToolResultsForBroadcast(partial),
          })
          return
        }
        // A failed conversational response must never fall through to the
        // heuristic browser planner and start reading the unrelated active tab.
        if (!browserToolsRequested) {
          sendTerminal({
            type: MSG.AGENT_TURN_COMPLETE,
            turnId,
            assistantMessage: summarizePartialAgentTurn(userMessage, []),
            toolResults: [],
          })
          return
        }
        sendTerminal({
          type: MSG.AGENT_TURN_ERROR,
          turnId,
          error: browserAgentErrorMessage(userMessage, llmErr?.message ?? String(llmErr)),
        })
        return
      }
    }

    sendTerminal({
      type: MSG.AGENT_TURN_ERROR,
      turnId,
      error: browserAgentErrorMessage(
        userMessage,
        accessToken ? 'browser_model_unavailable' : 'authentication_required',
      ),
    })
    return

  } catch (err) {
    sendTerminal({
      type: MSG.AGENT_TURN_ERROR,
      turnId,
      error: err?.message ?? String(err),
    })
  } finally {
    clearInterval(keepAliveId)
    try {
      await clearPresenceOnAllTabs()
    } catch {
      /* presence cleanup is best-effort */
    }
    turnControllers.delete(turnId)
    // Never leave the panel stuck if a path forgot to send a terminal event.
    if (!terminalSent) {
      broadcast({
        type: MSG.AGENT_TURN_ERROR,
        turnId,
        error: 'Agent turn ended unexpectedly.',
      })
    }
  }
}

/**
 * @param {string} approvalId
 * @param {AbortSignal} signal
 * @param {number} [timeoutMs]
 * @returns {Promise<'once'|'always'|'deny'|'cancelled'|'timeout'>}
 */
function waitForApproval(
  approvalId,
  signal,
  timeoutMs = 60_000,
  pendingMetadata = {},
) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve('cancelled')
      return
    }
    let settled = false
    const finish = (decision) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      signal.removeEventListener('abort', onAbort)
      if (pendingApprovals.get(approvalId)?.resolve === finish) {
        pendingApprovals.delete(approvalId)
      }
      resolve(decision)
    }
    const onAbort = () => {
      finish('cancelled')
    }
    signal.addEventListener('abort', onAbort)
    const timeoutId = setTimeout(() => finish('timeout'), timeoutMs)
    const existing = pendingApprovals.get(approvalId)
    existing?.resolve('cancelled')
    pendingApprovals.set(approvalId, { resolve: finish, ...pendingMetadata })
  })
}

async function makeExecutionContext(fallbackTabId, turnId, routineAllowedOrigins) {
  const tab = Number.isInteger(fallbackTabId)
    ? await chrome.tabs.get(fallbackTabId).catch(() => null)
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
  return {
    mode: await loadMode(),
    getSiteGrant: async (host) => {
      const allowedHosts = new Set(
        (routineAllowedOrigins ?? []).flatMap((origin) => {
          try {
            return [new URL(origin).hostname]
          } catch {
            return []
          }
        }),
      )
      if (allowedHosts.size > 0 && !allowedHosts.has(host)) return 'deny'
      return getGrant(host)
    },
    setSiteGrant: (host, decision) => upsertGrant(host, decision),
    activeTabId: tab?.id ?? fallbackTabId,
    onExecuting: (toolCall) => broadcast({
      type: MSG.AGENT_TOOL_EXECUTING,
      ...(turnId ? { turnId } : {}),
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    }),
  }
}

async function queryActiveTabMeta(preferredTabId) {
  const tab = Number.isInteger(preferredTabId)
    ? await chrome.tabs.get(preferredTabId).catch(() => null)
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
  return {
    id: tab?.id,
    url: tab?.url,
    title: tab?.title,
  }
}

async function queryNormalWindow() {
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] })
  return windows.find((window) => window.focused) ?? windows[0] ?? null
}

async function createScheduledRoutineTab(url, window) {
  if (!url || !window?.id) return null
  const tab = await chrome.tabs.create({
    windowId: window.id,
    url,
    active: false,
  })
  if (tab?.id) {
    await ensureVerbooTabGroup(tab.id).catch(() => {})
  }
  return tab
}

async function notifyRoutinePaused(notification) {
  if (!chrome.notifications?.create) {
    console.warn('[Verboo] Routine notifications are unavailable in this install.')
    return
  }
  const reason = String(notification?.reason ?? '')
    .replace(/^routine_variable_missing:/, 'missing variable: ')
    .replaceAll('_', ' ')
  const notificationId = `verboo-routine:${notification.routineId}:${Date.now()}`
  await chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: `Verboo — ${notification.title || 'Routine paused'}`,
    message: `Routine paused: ${reason}. Open Verboo to continue.`,
  })
}

async function openRoutineNotification() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.id) await openVerbooWorkspace(tab.id)
  for (const pending of pendingApprovals.values()) {
    if (!pending.toolCall) continue
    broadcast({
      type: MSG.AGENT_TOOL_REQUEST,
      ...(pending.turnId ? { turnId: pending.turnId } : {}),
      toolCall: pending.toolCall,
      policyDecision: pending.policy,
    })
  }
}

async function syncScheduledRoutines() {
  try {
    const session = await loadSession()
    if (session?.accountId) await routineScheduler.syncAccount(session.accountId)
  } catch (error) {
    console.warn('[Verboo] Could not restore routine alarms:', error)
  }
}

async function restoreRoutineExecutionState() {
  await syncScheduledRoutines()
  const session = await loadSession()
  if (session?.accountId) await recoverInterruptedRoutines(session.accountId)
}

async function recoverInterruptedRoutines(accountId) {
  const recovered = await routineRunStore.recoverInterrupted(accountId)
  for (const run of recovered) {
    try {
      const senderTabId = await resolveRecoveredRunTab(accountId, run)
      await routineRunner.resume(accountId, run.id, {
        senderTabId,
        waitForCompletion: false,
      })
    } catch (error) {
      console.warn(`[Verboo] Could not resume routine run ${run.id}:`, error)
    }
  }
}

async function resolveRecoveredRunTab(accountId, run) {
  if (Number.isInteger(run.senderTabId)) {
    const existing = await chrome.tabs.get(run.senderTabId).catch(() => null)
    if (existing?.id) return existing.id
  }
  const routine = await routinesStore.get(accountId, run.routineId)
  if (routine?.startUrl) {
    const window = await queryNormalWindow()
    const tab = await createScheduledRoutineTab(routine.startUrl, window)
    if (tab?.id) return tab.id
  }
  const active = await queryActiveTabMeta()
  if (!active?.id) throw new Error('run_tab_unavailable')
  return active.id
}

async function updateRoutineSchedule(message, remove) {
  const session = await loadSession()
  if (!session?.accountId) throw new Error('auth_required')
  const routine = remove
    ? await routineScheduler.remove(
        session.accountId,
        message.routineId,
        message.expectedRevision,
      )
    : await routineScheduler.upsert(
        session.accountId,
        message.routineId,
        message.schedule,
        message.expectedRevision,
      )
  broadcast({
    type: MSG.ROUTINE_SCHEDULE_CHANGED,
    change: remove ? 'removed' : 'updated',
    routine,
  })
  broadcast({
    type: MSG.ROUTINE_STATE_CHANGED,
    change: 'updated',
    routine,
  })
  return routine
}

async function listRoutineRuns() {
  const session = await loadSession()
  if (!session?.accountId) throw new Error('auth_required')
  return routineRunStore.list(session.accountId)
}

async function applyRoutineRecoverySuggestion(runId) {
  const session = await loadSession()
  if (!session?.accountId) throw new Error('auth_required')
  const result = await applyRecoverySuggestion({
    accountId: session.accountId,
    runId,
    runStore: routineRunStore,
    routinesStore,
  })
  broadcast({
    type: MSG.ROUTINE_STATE_CHANGED,
    change: 'updated',
    routine: result.routine,
  })
  broadcast({ type: MSG.ROUTINE_RUN_CHANGED, run: result.run })
  return result
}

function makeApprovalUi(turnId, signal, source = undefined) {
  return {
    request: async ({ toolCall, policy }) => {
      await setRoutineApprovalState(turnId, 'waiting_approval')
      broadcast({
        type: MSG.AGENT_TOOL_REQUEST,
        ...(turnId ? { turnId } : {}),
        toolCall,
        policyDecision: policy,
      })
      if (turnId && approvalSurfaces.size === 0) {
        const session = await loadSession()
        const run = session?.accountId
          ? await routineRunStore.get(session.accountId, turnId)
          : null
        const routine = run
          ? await routinesStore.get(session.accountId, run.routineId)
          : null
        if (routine) {
          await notifyRoutinePaused({
            routineId: routine.id,
            title: routine.name,
            reason: 'routine_approval_required',
          })
        }
      }
      return waitForApproval(toolCall.id, signal, 60_000, {
        turnId,
        toolCall,
        policy,
        source,
      })
    },
    onApprovalClosed: async ({ toolCall, decision }) => {
      await setRoutineApprovalState(turnId, 'running')
      broadcast({
        type: 'agent:approval_closed',
        ...(turnId ? { turnId } : {}),
        approvalId: toolCall.id,
        decision,
      })
    },
    onPolicyDenied: ({ toolCall, policy }) => broadcast({
      type: MSG.AGENT_TOOL_REQUEST,
      ...(turnId ? { turnId } : {}),
      toolCall,
      policyDecision: policy,
    }),
  }
}

function cancelPendingApprovals(source) {
  for (const [id, pending] of pendingApprovals.entries()) {
    if (pending.source !== source) continue
    pending.resolve('cancelled')
    pendingApprovals.delete(id)
  }
}

async function setRoutineApprovalState(runId, status) {
  if (!runId) return
  const session = await loadSession()
  if (!session?.accountId) return
  const run = await routineRunStore.get(session.accountId, runId)
  if (!run) return
  if (
    (status === 'waiting_approval' && run.status !== 'running') ||
    (status === 'running' && run.status !== 'waiting_approval')
  ) {
    return
  }
  const updated = await routineRunStore.transition(session.accountId, runId, status)
  broadcast({ type: MSG.ROUTINE_RUN_CHANGED, run: updated })
}

/**
 * @param {string} turnId
 */
function cancelTurn(turnId) {
  browserControlQueue.cancel(turnId)
  abortTurnController(turnId)
  // Resolve any pending approvals as cancelled.
  for (const [id, p] of pendingApprovals.entries()) {
    p.resolve('cancelled')
    pendingApprovals.delete(id)
  }
  turnControllers.delete(turnId)
  try {
    void clearPresenceOnAllTabs()
  } catch {
    /* presence cleanup is best-effort */
  }
}

function abortTurnController(turnId) {
  turnControllers.get(turnId)?.abort()
}

function browserAgentErrorMessage(userMessage, code) {
  const pt = looksLikePortuguese(userMessage)
  const detail = String(code ?? 'unknown_error')
  if (detail === 'authentication_required') {
    return pt
      ? 'Sua sessão expirou e não pôde ser renovada. Entre novamente para continuar.'
      : 'Your session expired and could not be renewed. Sign in again to continue.'
  }
  if (detail === 'browser_model_unavailable') {
    return pt
      ? 'Nenhum modelo está disponível para controlar o navegador.'
      : 'No model is available for browser control.'
  }
  if (/model_tool_protocol_unsupported|malformed text tool call/i.test(detail)) {
    return pt
      ? 'O modelo selecionado não respondeu no protocolo de ferramentas do navegador. Escolha outro modelo e tente novamente.'
      : 'The selected model did not respond with the browser tool protocol. Choose another model and try again.'
  }
  if (detail === 'screenshot_requires_visual_model') {
    return pt
      ? 'O modelo selecionado não aceita imagens. Escolha um modelo marcado como Visual para capturar e analisar a tela.'
      : 'The selected model does not accept images. Choose a model marked Visual to capture and analyze the screen.'
  }
  return pt
    ? `O agente do navegador parou antes de concluir: ${detail}`
    : `The browser agent stopped before completion: ${detail}`
}

/**
 * Lightweight PT detector for assistant copy (matches agent loop intent).
 * @param {string} text
 */
function looksLikePortuguese(text) {
  const s = String(text ?? '')
  if (/[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/.test(s)) return true
  return /\b(abra|abre|abrir|coloque|coloca|procure|pesquis|toque|tocar|m[uú]sica|musica|quero|pode|obrigad)\w*\b/i.test(
    s,
  )
}

async function createTemporaryDraftFromMessage(text) {
  const session = await ensureFreshSession()
  if (!session?.accountId) throw new Error('auth_required')
  const page = await queryActiveTabMeta()
  const draft = buildPromptDraft(text, page)
  return {
    entry: await temporaryDraftStore.save(session.accountId, draft),
  }
}

async function startRoutineRecording(senderTabId) {
  const session = await ensureFreshSession()
  if (!session?.accountId) throw new Error('auth_required')
  const tab = Number.isInteger(senderTabId)
    ? await chrome.tabs.get(senderTabId)
    : await queryActiveTabMeta()
  const tabId = tab?.id
  if (!Number.isInteger(tabId) || !/^https?:\/\//i.test(tab?.url ?? '')) {
    throw new Error('routine_recording_page_unavailable')
  }
  return recordingController.start(session.accountId, tabId)
}

async function stopRoutineRecording() {
  const session = await loadSession()
  if (!session?.accountId) throw new Error('auth_required')
  const stopped = await recordingController.stop(session.accountId)
  const entry = await temporaryDraftStore.save(session.accountId, stopped.draft)
  return { draftId: entry.id, draft: entry.draft }
}

async function cancelRoutineRecording() {
  const session = await loadSession()
  if (!session?.accountId) throw new Error('auth_required')
  return recordingController.cancel(session.accountId)
}

async function createTemporaryDraftFromConversation(history) {
  const session = await ensureFreshSession()
  if (!session?.accountId || !session?.accessToken) throw new Error('auth_required')
  const selectedModelId = await getSelectedModelId()
  if (!selectedModelId) throw new Error('routine_model_missing')

  let modelDraft = null
  try {
    const completion = await chatCompletion({
      accessToken: session.accessToken,
      model: selectedModelId,
      messages: [
        {
          role: 'system',
          content:
            'Convert the conversation into one editable browser routine draft. ' +
            'Return JSON only with name, command, description, instructions, startUrl, ' +
            'allowedOrigins, modelId, and cleanupCreatedTabs. Do not include account data, ' +
            'secrets, assistant commentary, selectors, or executable code.',
        },
        {
          role: 'user',
          content: JSON.stringify((Array.isArray(history) ? history : []).slice(-12)),
        },
      ],
      tools: [],
      refreshAccessToken: async () => {
        const refreshed = await refreshSession()
        return refreshed?.accessToken ?? null
      },
    })
    modelDraft = completion.content
  } catch {
    // Deterministic user-message-only fallback remains available offline.
  }

  const draft = buildConversationDraft(history, modelDraft)
  return {
    entry: await temporaryDraftStore.save(session.accountId, draft),
  }
}

async function addRoutineAsset(message) {
  const session = await loadSession()
  if (!session?.accountId) throw new Error('auth_required')
  const routine = await routinesStore.get(session.accountId, message.routineId)
  if (!routine) throw new Error('routine_not_found')
  const file = assetPayloadToFile(message.asset)
  const asset = await routineAssetsStore.add(session.accountId, routine.id, file)
  try {
    const updated = await routinesStore.update(
      session.accountId,
      routine.id,
      routine.revision,
      { assets: [...(routine.assets ?? []), asset] },
    )
    broadcast({
      type: MSG.ROUTINE_STATE_CHANGED,
      change: 'updated',
      routine: updated,
    })
    return { asset, routine: updated }
  } catch (error) {
    await routineAssetsStore.remove(session.accountId, asset.id)
    throw error
  }
}

async function removeRoutineAsset(message) {
  const session = await loadSession()
  if (!session?.accountId) throw new Error('auth_required')
  const asset = await routineAssetsStore.get(session.accountId, message.assetId)
  if (!asset) throw new Error('routine_asset_not_found')
  const routine = await routinesStore.get(session.accountId, asset.routineId)
  if (!routine) throw new Error('routine_not_found')
  const updated = await routinesStore.update(
    session.accountId,
    routine.id,
    routine.revision,
    {
      assets: (routine.assets ?? []).filter((item) => item.id !== asset.id),
    },
  )
  await routineAssetsStore.remove(session.accountId, asset.id)
  broadcast({
    type: MSG.ROUTINE_STATE_CHANGED,
    change: 'updated',
    routine: updated,
  })
  return { removed: true, routine: updated }
}

function assetPayloadToFile(payload) {
  if (!payload || typeof payload.dataBase64 !== 'string') {
    throw new Error('asset_invalid')
  }
  const binary = atob(payload.dataBase64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return {
    name: String(payload.name ?? 'asset'),
    type: String(payload.type ?? ''),
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer,
  }
}

/**
 * Broadcast a message to all extension contexts (side panel, popup, etc.).
 * @param {object} message
 */
function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Listener may be absent (panel closed); ignore.
  })
}
