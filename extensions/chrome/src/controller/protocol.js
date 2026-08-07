/**
 * protocol.js — Message protocol contracts for background ↔ panel ↔ controller.
 *
 * Single source of truth for message types and shapes. ANVIL (controller) and
 * PRISM (panel) MUST import from here — no magic strings.
 *
 * All messages flow through chrome.runtime.sendMessage / onMessage.
 * The controller (service worker) is the authority; the panel is a view.
 *
 * Multi-user: zero hardcoded path/user/token.
 *
 * ── INVARIANT: execute() is the only entry point for tool execution ──
 *
 * Tool handlers (chrome.tabs, chrome.scripting, chrome.debugger, etc.) MUST
 * NEVER be called directly from agent.js, background.js, or panel.js. The
 * single chokepoint is `controller.execute(toolCall)` in controller.js.
 *
 * `execute()` enforces the policy gate (evaluateToolPolicy) before any
 * dispatch. Bypassing it means bypassing Hard Blocks, site grants, and the
 * Manual/Auto/Skip mode contract — which is a security violation.
 *
 * Forbidden patterns (AEGIS audits for these in review):
 *   - chrome.scripting.executeScript(...) called outside src/controller/tools/*,
 *     except the narrow, user-gesture-only selection read in
 *     src/selectionContext.js. That code reads `window.getSelection()` only,
 *     cannot mutate the page, is never model-initiated, and its result is
 *     fenced as untrusted content before a user-started turn.
 *   - chrome.tabs.update(...) called outside src/controller/tools/navigate.js
 *   - chrome.debugger.attach(...) called outside src/controller/tools/screenshot.js
 *   - Any tool handler imported and invoked from agent.js or background.js
 *     without going through controller.execute()
 *   - Panel sending a message that directly triggers a tool handler (the
 *     panel may start a turn, resolve approval, or read/discard its own
 *     pending selected-text context; only the turn can reach a tool handler)
 *
 * The dispatchTool() helper inside controller.js is the ONLY function allowed
 * to call tool handlers directly. It is private to the controller module and
 * must never be exported.
 */

import browserCatalog from './browserTools.js'

// ── Message types ──────────────────────────────────────────

export const MSG = Object.freeze({
  // Panel → Controller
  AGENT_TURN_START: 'agent:turn_start',       // user submits a chat message
  AGENT_TURN_CANCEL: 'agent:turn_cancel',     // user cancels in-flight turn
  SELECTION_CONTEXT_GET: 'selection_context:get',
  SELECTION_CONTEXT_DISCARD: 'selection_context:discard',
  TOOL_PENDING_LIST: 'tool:pending_list',     // panel restores approvals after reopening
  TOOL_APPROVE: 'tool:approve',               // user approves a needsApproval tool
  TOOL_DENY: 'tool:deny',                     // user denies a needsApproval tool
  AUTH_LOGIN: 'auth:login',                   // start user-initiated OAuth PKCE flow
  AUTH_LOGOUT: 'auth:logout',
  AUTH_REFRESH: 'auth:refresh',
  AUTH_STATE_REQUEST: 'auth:state_request',   // panel asks SW for current session
  MODELS_LIST: 'models:list',                 // panel asks SW for available models
  MODELS_SELECT: 'models:select',             // panel persists selected modelId
  POLICY_MODE_SET: 'policy:mode_set',
  POLICY_GRANT_UPSERT: 'policy:grant_upsert',
  POLICY_GRANT_REMOVE: 'policy:grant_remove',
  ROUTINE_LIST: 'routine:list',
  ROUTINE_GET: 'routine:get',
  ROUTINE_CREATE: 'routine:create',
  ROUTINE_UPDATE: 'routine:update',
  ROUTINE_DUPLICATE: 'routine:duplicate',
  ROUTINE_DELETE: 'routine:delete',
  ROUTINE_RUN: 'routine:run',
  ROUTINE_SIMULATE: 'routine:simulate',
  ROUTINE_CANCEL: 'routine:cancel',
  ROUTINE_PAUSE: 'routine:pause',
  ROUTINE_RESUME: 'routine:resume',
  ROUTINE_RUN_LIST: 'routine:run_list',
  ROUTINE_RECOVERY_APPLY: 'routine:recovery_apply',
  ROUTINE_DRAFT_FROM_MESSAGE: 'routine:draft_from_message',
  ROUTINE_DRAFT_FROM_CONVERSATION: 'routine:draft_from_conversation',
  ROUTINE_DRAFT_GET: 'routine:draft_get',
  ROUTINE_ASSET_ADD: 'routine:asset_add',
  ROUTINE_ASSET_DELETE: 'routine:asset_delete',
  ROUTINE_RECORD_START: 'routine:record_start',
  ROUTINE_RECORD_STOP: 'routine:record_stop',
  ROUTINE_RECORD_CANCEL: 'routine:record_cancel',
  ROUTINE_RECORD_EVENT: 'routine:record_event',
  ROUTINE_RECORD_STATE_REQUEST: 'routine:record_state_request',
  ROUTINE_SCHEDULE_UPSERT: 'routine:schedule_upsert',
  ROUTINE_SCHEDULE_REMOVE: 'routine:schedule_remove',

  // Controller → Panel
  AGENT_TURN_STARTED: 'agent:turn_started',
  AGENT_THOUGHT: 'agent:thought',             // streaming assistant thought
  AGENT_TOOL_REQUEST: 'agent:tool_request',  // tool call awaiting approval
  AGENT_TOOL_EXECUTING: 'agent:tool_executing',
  AGENT_TOOL_RESULT: 'agent:tool_result',
  AGENT_TURN_COMPLETE: 'agent:turn_complete',
  AGENT_TURN_ERROR: 'agent:turn_error',
  SELECTION_CONTEXT_CHANGED: 'selection_context:changed',
  AUTH_STATE_CHANGED: 'auth:state_changed',
  MODELS_STATE_CHANGED: 'models:state_changed',
  POLICY_MODE_CHANGED: 'policy:mode_changed',
  POLICY_GRANT_CHANGED: 'policy:grant_changed',
  ROUTINE_STATE_CHANGED: 'routine:state_changed',
  ROUTINE_RUN_CHANGED: 'routine:run_changed',
  ROUTINE_RECORD_STATE_CHANGED: 'routine:record_state_changed',
  ROUTINE_SCHEDULE_CHANGED: 'routine:schedule_changed',
})

// ── Tool Call envelope ────────────────────────────────────

/**
 * Tool catalog version. Bumped when a new tool kind is added or when the
 * shape of an existing tool's params changes in a non-backward-compatible way.
 * Clients (panel, Desktop bridge, agent loop) compare this against the version
 * they were built against and refuse to start a turn if it is older than the
 * minimum supported.
 *
 * Version history:
 *   - 0.1.0 (P1): hard blocks + site grants + mode store, no tools yet
 *   - 0.2.0 (P2): MVP catalog — navigate, read_page, click, type, screenshot, tabs, tab_group
 *   - 0.3.0 (P5): full catalog — +console_reader, network_reader, console_clear,
 *                 gif_recording, session_recording, file_upload, schedule_task,
 *                 workflow_record, workflow_replay, history_read
 *
 * Adding a tool:
 *   1. Add the kind to BrowserTool in src/controller/types.ts (TS contract)
 *   2. Add the risk class to TOOL_RISK_MAP below (gate input)
 *   3. Implement handler in src/controller/tools/<name>.js
 *   4. Add dispatch case in src/controller/execute.js dispatch()
 *   5. Add unit test in src/controller/tools/<name>.test.js
 *   6. Bump CATALOG_VERSION, append a version-history line above
 *   7. Update PRIVACY.md + PERMISSIONS.md + STORE_LISTING.md if the tool
 *      requires a new permission (AEGIS audit required for elevated tools)
 *
 * Multi-user: zero hardcoded path/user/token. accountId from session
 * distinguishes users.
 */

/**
 * ToolCall — what the agent loop produces and the controller executes.
 *
 * @typedef {Object} ToolCall
 * @property {string} id                  - UUID, stable across the turn
 * @property {string} name                - Tool kind (see TOOL_RISK_MAP)
 * @property {'read'|'mutate'|'elevated'} risk - Risk class for policy gate
 * @property {string} input               - Tool name + params joined for Hard Block matching
 * @property {Record<string, unknown>} params - Tool-specific parameters (BrowserTool shape)
 * @property {string} [reasoning]         - Why the agent chose this tool (shown in panel)
 */
export const TOOL_RISK = Object.freeze({
  READ: 'read',
  MUTATE: 'mutate',
  ELEVATED: 'elevated',
})

/** Bump in browserTools.js (and the JSON reference copy) on every catalog change. */
export const CATALOG_VERSION = browserCatalog.version

/**
 * Executable browser tools. Planned handlers that lack required Chrome
 * permissions are deliberately absent so neither the LLM nor MCP can call
 * them accidentally.
 */
export const BROWSER_TOOL_CATALOG = Object.freeze(browserCatalog.tools)

const TOOL_BY_NAME = new Map(BROWSER_TOOL_CATALOG.map((tool) => [tool.name, tool]))

// Risk classification is derived from the catalog. Callers may display it,
// but execute() reconstructs it and never trusts caller-provided metadata.
export const TOOL_RISK_MAP = Object.freeze(Object.fromEntries(
  BROWSER_TOOL_CATALOG.map((tool) => [tool.name, tool.risk]),
))

// ── Policy Decision (mirrors evaluateToolPolicy.js output) ──

/**
 * @typedef {Object} PolicyDecision
 * @property {boolean} allowed
 * @property {boolean} needsApproval
 * @property {string} reason
 * @property {string} [hardBlockLabel]
 */

// ── Tool Result ───────────────────────────────────────────

/**
 * @typedef {Object} ToolResult
 * @property {string} toolCallId           - Matches ToolCall.id
 * @property {boolean} success
 * @property {unknown} [data]              - Tool-specific result payload
 * @property {string} [error]              - Error message if !success
 * @property {number} durationMs
 */

// ── Agent Turn envelope ───────────────────────────────────

/**
 * @typedef {Object} AgentTurnStart
 * @property {string} turnId               - UUID for the whole turn
 * @property {string} userMessage          - User's chat input
 * @property {string} [selectionContextId] - Pending page-selection context to consume once
 * @property {number} [selectionContextTabId] - Tab that owns the pending selection
 */

/**
 * @typedef {Object} AgentTurnComplete
 * @property {string} turnId
 * @property {string} assistantMessage     - Final assistant text
 * @property {ToolResult[]} toolResults    - All tool results from this turn
 */

// ── Message payload shapes (for type-checking in handlers) ──

export const MSG_SHAPES = Object.freeze({
  [MSG.AGENT_TURN_START]: {
    turnId: 'string',
    userMessage: 'string',
    selectionContextId: 'string?',
    selectionContextTabId: 'number?',
  },
  [MSG.AGENT_TURN_CANCEL]: { turnId: 'string' },
  [MSG.SELECTION_CONTEXT_GET]: { tabId: 'number' },
  [MSG.SELECTION_CONTEXT_DISCARD]: { tabId: 'number', selectionContextId: 'string' },
  [MSG.TOOL_PENDING_LIST]: {},
  [MSG.TOOL_APPROVE]:      { toolCallId: 'string', decision: 'once|always' },
  [MSG.TOOL_DENY]:         { toolCallId: 'string', reason: 'string?' },
  [MSG.AGENT_TOOL_REQUEST]:{ toolCall: 'object', policyDecision: 'object' },
  [MSG.AGENT_TOOL_RESULT]: { toolResult: 'object' },
  [MSG.AGENT_TURN_COMPLETE]:{ turnId: 'string', assistantMessage: 'string', toolResults: 'array' },
  [MSG.AGENT_TURN_ERROR]:  { turnId: 'string', error: 'string' },
  [MSG.SELECTION_CONTEXT_CHANGED]: { tabId: 'number', context: 'object' },
  [MSG.AUTH_STATE_CHANGED]:{ session: 'object?' },
  [MSG.MODELS_STATE_CHANGED]:{ models: 'array', selectedId: 'string?' },
  [MSG.POLICY_MODE_CHANGED]:{ mode: 'string' },
  [MSG.POLICY_GRANT_CHANGED]:{ grants: 'array' },
})

// ── Helper: build a ToolCall ──────────────────────────────

/**
 * @param {string} name - Tool kind
 * @param {Record<string, unknown>} params - Tool-specific params
 * @param {string} [reasoning]
 * @returns {ToolCall}
 */
export function makeToolCall(name, params, reasoning) {
  const id = crypto.randomUUID()
  return { id, name, params, reasoning }
}

/**
 * Rebuild a raw caller request into the only ToolCall shape accepted by the
 * policy engine and dispatcher.
 *
 * @param {unknown} raw
 * @returns {{ ok: true; toolCall: import('./protocol.js').ToolCall; policyHost?: string } | { ok: false; error: string }}
 */
export function canonicalizeToolCall(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !raw.name) {
    return { ok: false, error: 'invalid_tool_call' }
  }

  const definition = TOOL_BY_NAME.get(raw.name)
  if (!definition) return { ok: false, error: 'unknown_tool' }

  const params = raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)
    ? { ...raw.params }
    : {}
  const validationError = validateToolParams(definition, params)
  if (validationError) return { ok: false, error: validationError }

  const toolCall = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID(),
    name: definition.name,
    risk: definition.risk,
    input: serializeCanonicalInput(definition.name, params),
    params,
    ...(typeof raw.reasoning === 'string' ? { reasoning: raw.reasoning } : {}),
  }
  const policyHost = resolvePolicyHost(toolCall)
  return { ok: true, toolCall, ...(policyHost ? { policyHost } : {}) }
}

/**
 * @param {{ inputSchema: { required?: string[]; properties?: Record<string, {type?: string; enum?: unknown[]; items?: {type?: string}}> } }} definition
 * @param {Record<string, unknown>} params
 * @returns {string | null}
 */
function validateToolParams(definition, params) {
  const schema = definition.inputSchema
  const properties = schema.properties ?? {}

  for (const key of schema.required ?? []) {
    if (!(key in params) || params[key] == null || params[key] === '') {
      return `invalid_params:${key}_required`
    }
  }

  for (const [key, value] of Object.entries(params)) {
    const property = properties[key]
    if (!property) return `invalid_params:${key}_unknown`
    if (!matchesJsonType(value, property.type, property.items?.type)) {
      return `invalid_params:${key}_must_be_${property.type}`
    }
    if (property.enum && !property.enum.includes(value)) {
      return `invalid_params:${key}_invalid`
    }
  }

  if (definition.name === 'navigate') {
    if (!httpHost(params.url)) return 'invalid_params:url_must_be_http'
  }
  if (definition.name === 'tabs') {
    if ((params.action === 'switch' || params.action === 'close') && !Number.isInteger(params.tabId)) {
      return 'invalid_params:tabId_required'
    }
    if (params.action === 'new' && params.url != null && params.url !== 'about:newtab' && !httpHost(params.url)) {
      return 'invalid_params:url_must_be_http'
    }
  }
  if (definition.name === 'tab_group') {
    if (params.action === 'remove' && !Number.isInteger(params.groupId)) {
      return 'invalid_params:groupId_required'
    }
    if (params.action === 'assign' && !Number.isInteger(params.groupId)) {
      return 'invalid_params:groupId_required'
    }
    if (['create', 'assign', 'unassign'].includes(params.action) && (!Array.isArray(params.tabIds) || params.tabIds.length === 0)) {
      return 'invalid_params:tabIds_required'
    }
  }

  return null
}

/** @param {unknown} value @param {string|undefined} type @param {string|undefined} itemType */
function matchesJsonType(value, type, itemType) {
  if (!type) return true
  if (type === 'integer') return Number.isInteger(value)
  if (type === 'array') {
    return Array.isArray(value) && (!itemType || value.every((item) => matchesJsonType(item, itemType)))
  }
  if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  return typeof value === type
}

/** @param {string} name @param {Record<string, unknown>} params */
export function serializeCanonicalInput(name, params) {
  const entries = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
  return [name, ...entries].join(' ')
}

/** @param {{name: string; params: Record<string, unknown>}} toolCall */
export function resolvePolicyHost(toolCall) {
  if (toolCall.name === 'navigate') return httpHost(toolCall.params.url)
  if (toolCall.name === 'tabs' && toolCall.params.action === 'new') {
    return httpHost(toolCall.params.url)
  }
  return ''
}

/** @param {unknown} value */
function httpHost(value) {
  if (typeof value !== 'string') return ''
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.host : ''
  } catch {
    return ''
  }
}
