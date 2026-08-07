/**
 * Extension TypeScript contracts — BrowserTool discriminated union.
 *
 * Catalog version: 0.3.0 (P5 — full catalog).
 * Mirror `CATALOG_VERSION` in src/controller/protocol.js — bump both together.
 *
 * See src/controller/protocol.js for the catalog-version-history comment and
 * the checklist for adding a new tool kind.
 *
 * MVP tools (P2): navigate, read_page, click, type, screenshot, tabs, tab_group.
 * P5 additions: console_reader, network_reader, console_clear, gif_recording,
 * session_recording, file_upload, schedule_task, workflow_record,
 * workflow_replay, history_read.
 *
 * Multi-user: no hardcoded paths, users, or tokens. accountId from the Verboo
 * session (chrome.storage.local['verbooSession']) distinguishes users.
 */

// ── Discriminated Union ────────────────────────────────────

export type RiskClass = 'read' | 'mutate' | 'elevated'

export type ToolKind =
  // MVP (P2)
  | 'navigate'
  | 'read_page'
  | 'click'
  | 'type'
  | 'screenshot'
  | 'tabs'
  // P5 full catalog
  | 'console_reader'
  | 'network_reader'
  | 'console_clear'
  | 'gif_recording'
  | 'session_recording'
  | 'file_upload'
  | 'schedule_task'
  | 'workflow_record'
  | 'workflow_replay'
  | 'history_read'

export type BrowserTool =
  | NavigateTool
  | ReadPageTool
  | ClickTool
  | TypeTool
  | ScreenshotTool
  | TabsTool
  | TabGroupTool
  | ConsoleReaderTool
  | NetworkReaderTool
  | ConsoleClearTool
  | GifRecordingTool
  | SessionRecordingTool
  | FileUploadTool
  | ScheduleTaskTool
  | WorkflowRecordTool
  | WorkflowReplayTool
  | HistoryReadTool

// ── Tool Shapes ────────────────────────────────────────────

export interface NavigateTool {
  kind: 'navigate'
  url: string
}

export interface ReadPageTool {
  kind: 'read_page'
  /** Optional CSS selector; omit for full page. */
  selector?: string
  /** Attribute to extract; omit for textContent. */
  attribute?: string
}

export interface ClickTool {
  kind: 'click'
  selector: string
  /** Button index: 0 = primary, 1 = middle, 2 = secondary. */
  button?: number
}

export interface TypeTool {
  kind: 'type'
  selector: string
  text: string
  /** Clear field before typing. */
  clear?: boolean
}

export interface ScreenshotTool {
  kind: 'screenshot'
  /** 'viewport' (default) or 'fullPage'. */
  format?: 'viewport' | 'fullPage'
}

export interface TabsTool {
  kind: 'tabs'
  action: 'list' | 'switch' | 'close' | 'new'
  /** Tab ID for switch/close. */
  tabId?: number
  /** URL for new tab. */
  url?: string
}

export interface TabGroupTool {
  kind: 'tab_group'
  action: 'create' | 'remove' | 'assign' | 'unassign'
  groupId?: number
  tabIds?: number[]
  title?: string
  color?: 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan'
}

// ── P5: read-only additions ────────────────────────────────

/** Read console logs from the active tab. Risk: read. No new permission. */
export interface ConsoleReaderTool {
  kind: 'console_reader'
  /** Optional: filter by level ('log'|'warn'|'error'|'info'|'debug'). */
  level?: 'log' | 'warn' | 'error' | 'info' | 'debug' | 'all'
  /** Maximum number of entries to return. Default 100. */
  limit?: number
  /** Clear captured logs after returning. */
  clear?: boolean
}

/** Read network requests via chrome.debugger Network domain. Risk: read. REQUIRES 'debugger' permission. */
export interface NetworkReaderTool {
  kind: 'network_reader'
  /** Optional URL pattern filter (glob). */
  urlPattern?: string
  /** Maximum number of entries to return. Default 100. */
  limit?: number
  /** Only requests in this state. */
  state?: 'pending' | 'complete' | 'failed'
}

// ── P5: mutate additions ──────────────────────────────────

/** Clear captured console logs. Risk: mutate. No new permission. */
export interface ConsoleClearTool {
  kind: 'console_clear'
}

/** Capture a GIF recording of the active tab. Risk: mutate. */
export interface GifRecordingTool {
  kind: 'gif_recording'
  action: 'start' | 'stop' | 'status'
  /** Maximum duration in ms (default 10000). */
  maxDurationMs?: number
  /** Frame interval in ms (default 100). */
  frameIntervalMs?: number
}

/** Record session events for later replay. Risk: mutate. */
export interface SessionRecordingTool {
  kind: 'session_recording'
  action: 'start' | 'stop' | 'discard'
  /** Recording label for identification. */
  label?: string
}

/** Schedule a tool call via chrome.alarms. Risk: mutate. REQUIRES 'alarms' permission. */
export interface ScheduleTaskTool {
  kind: 'schedule_task'
  action: 'create' | 'cancel' | 'list'
  /** Alarm name (must be unique). */
  name?: string
  /** When to fire (ms since epoch), or in N minutes via delayMin. */
  when?: number
  /** Delay in minutes from now. Mutually exclusive with `when`. */
  delayMin?: number
  /** The tool call to execute when the alarm fires. */
  toolCall?: BrowserTool
}

/** Record a workflow (sequence of tool calls). Risk: mutate. */
export interface WorkflowRecordTool {
  kind: 'workflow_record'
  action: 'start' | 'stop' | 'append'
  /** Workflow name. */
  name?: string
  /** Tool call to append (for 'append'). */
  toolCall?: BrowserTool
}

/** Replay a recorded workflow. Risk: mutate. */
export interface WorkflowReplayTool {
  kind: 'workflow_replay'
  /** Name of the workflow to replay. */
  name: string
  /** Override tool params before replay. */
  paramOverrides?: Record<string, Record<string, unknown>>
}

// ── P5: elevated additions (ALWAYS re-prompt, NO always-allow) ──

/**
 * Upload a file via file input. Risk: elevated. REQUIRES 'debugger' permission
 * (for DOM.setFileInputFiles via CDP). ALWAYS re-prompts.
 */
export interface FileUploadTool {
  kind: 'file_upload'
  /** CSS selector of the file input element. */
  selector: string
  /** Absolute paths to files to upload. NEVER hardcode; user must supply at runtime. */
  files: string[]
}

/**
 * Read the user's browser history. Risk: elevated. REQUIRES 'history'
 * permission. NEVER allowed via 'always' grant — always re-prompts.
 */
export interface HistoryReadTool {
  kind: 'history_read'
  /** Free-text query. Empty = recent history. */
  query?: string
  /** Max results. Default 100. */
  maxResults?: number
  /** Time window start (ms since epoch). */
  startTime?: number
  /** Time window end (ms since epoch). */
  endTime?: number
}

// ── Results ───────────────────────────────────────────────

export interface ToolResult {
  success: boolean
  data?: unknown
  error?: string
  durationMs: number
}

export interface TabInfo {
  tabId: number
  url: string
  title: string
  active: boolean
  groupId?: number
  windowId: number
}

export interface BrowserState {
  activeTabId: number
  tabs: TabInfo[]
  url: string
  title: string
}

/** Snapshot of captured console logs (returned by console_reader). */
export interface ConsoleLogEntry {
  level: 'log' | 'warn' | 'error' | 'info' | 'debug'
  message: string
  timestamp: number
  url?: string
  lineNumber?: number
}

/** Snapshot of a network request (returned by network_reader). */
export interface NetworkRequestEntry {
  requestId: string
  url: string
  method: string
  status?: number
  state: 'pending' | 'complete' | 'failed'
  startedAt: number
  completedAt?: number
  /** Request/response size in bytes. */
  size?: number
  /** Truncated request headers (sensitive headers redacted). */
  requestHeaders?: Record<string, string>
  /** Truncated response headers. */
  responseHeaders?: Record<string, string>
}

