export const NATIVE_MESSAGING_HOST_NAME = 'com.verboo.code.browser_extension'
export const BROWSER_BRIDGE_PROTOCOL_VERSION = 1

const DEFAULT_RECONNECT_DELAY_MS = 750
const MAX_RECONNECT_DELAY_MS = 30_000

/**
 * @param {{
 *   chromeApi?: typeof chrome;
 *   executeWithApproval: Function;
 *   contextFactory: Function;
 *   approvalUiFactory: Function;
 *   isApprovalUiAvailable: () => boolean;
 *   cancelPendingApprovals?: () => Promise<void>|void;
 *   clearPresenceOnAllTabs: () => Promise<void>;
 *   reconnectDelayMs?: number;
 * }} dependencies
 */
export function createNativeBridge({
  chromeApi = chrome,
  executeWithApproval,
  contextFactory,
  approvalUiFactory,
  isApprovalUiAvailable,
  cancelPendingApprovals = async () => {},
  clearPresenceOnAllTabs,
  reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
}) {
  let port = null
  let stopped = false
  let startupRegistered = false
  let reconnectAttempt = 0
  let reconnectTimer = null

  // The host only exists after the desktop app configures the integration.
  // A single retry meant an extension installed before that step gave up
  // forever, so reconnection now backs off but never stops trying.
  function scheduleReconnect() {
    if (stopped || reconnectTimer) return
    const delay = Math.min(
      reconnectDelayMs * 2 ** reconnectAttempt,
      MAX_RECONNECT_DELAY_MS,
    )
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (!stopped) connect()
    }, delay)
  }

  function connect() {
    stopped = false
    if (port) return true
    try {
      const nextPort = chromeApi.runtime.connectNative(NATIVE_MESSAGING_HOST_NAME)
      port = nextPort
      nextPort.onMessage.addListener((message) => {
        // A real message proves the host is alive: restart the backoff.
        reconnectAttempt = 0
        void handleMessage(nextPort, message)
      })
      nextPort.onDisconnect.addListener(() => {
        if (port !== nextPort) return
        port = null
        const failure = chromeApi.runtime?.lastError
        if (failure) {
          console.warn('[verboo] native bridge disconnected:', failure.message)
        }
        void Promise.resolve()
          .then(() => cancelPendingApprovals())
          .catch(() => {
            // Approval cancellation is best-effort; presence cleanup still runs.
          })
          .then(() => clearPresenceOnAllTabs())
          .catch(() => {
            // Cleanup is best-effort when the native host disappears abruptly.
          })
        scheduleReconnect()
      })
      return true
    } catch (error) {
      // Silent failure here hid the real cause (missing host, blocked
      // executable) from anyone reading the service worker console.
      console.warn('[verboo] connectNative failed:', error?.message ?? error)
      port = null
      scheduleReconnect()
      return false
    }
  }

  function disconnect() {
    stopped = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    const current = port
    port = null
    try {
      current?.disconnect()
    } catch {
      // The native port may already be closed.
    }
  }

  function registerStartup() {
    if (startupRegistered) return
    startupRegistered = true
    chromeApi.runtime.onStartup.addListener(() => {
      reconnectAttempt = 0
      connect()
    })
  }

  function sendResponse(envelope) {
    return postTo(port, envelope)
  }

  function postTo(target, envelope) {
    if (!target || target !== port) return false
    try {
      target.postMessage(envelope)
      return true
    } catch {
      return false
    }
  }

  async function handleMessage(sourcePort, envelope) {
    const validation = validateEnvelope(envelope)
    if (!validation.ok) {
      postTo(sourcePort, errorEnvelope(validation.id, validation.code, validation.message))
      return
    }

    const { id, payload } = envelope
    if (envelope.kind === 'turnComplete') {
      try {
        try {
          await cancelPendingApprovals()
        } catch {
          // Approval cancellation is best-effort; presence cleanup still runs.
        }
        await clearPresenceOnAllTabs()
        postTo(sourcePort, {
          version: BROWSER_BRIDGE_PROTOCOL_VERSION,
          id,
          kind: 'turnCompleteAck',
          payload: { ok: true },
        })
      } catch (error) {
        postTo(sourcePort, errorEnvelope(id, 'execution_failed', error?.message ?? String(error)))
      }
      return
    }

    const rawToolCall = {
      id,
      name: payload.name,
      params: payload.arguments,
    }
    const baseApprovalUi = approvalUiFactory()
    const approvalUi = {
      ...baseApprovalUi,
      request: async (request) => {
        if (!isApprovalUiAvailable()) {
          const error = new Error('Open the Verboo side panel in Chrome to approve this action.')
          error.code = 'approval_ui_unavailable'
          throw error
        }
        return baseApprovalUi.request(request)
      },
    }

    try {
      const result = await executeWithApproval(rawToolCall, contextFactory, approvalUi)
      if (!result?.ok) {
        const code = executionErrorCode(result?.error)
        postTo(sourcePort, errorEnvelope(id, code, executionErrorMessage(code, result?.error)))
        return
      }
      postTo(sourcePort, {
        version: BROWSER_BRIDGE_PROTOCOL_VERSION,
        id,
        kind: 'toolResponse',
        payload: result,
      })
    } catch (error) {
      const code = error?.code === 'approval_ui_unavailable'
        ? 'approval_ui_unavailable'
        : 'execution_failed'
      postTo(sourcePort, errorEnvelope(id, code, error?.message ?? String(error)))
    }
  }

  return {
    connect,
    disconnect,
    registerStartup,
    sendResponse,
  }
}

function validateEnvelope(envelope) {
  const id = typeof envelope?.id === 'string' && envelope.id ? envelope.id : 'bridge'
  if (!envelope || typeof envelope !== 'object') {
    return { ok: false, id, code: 'malformed_envelope', message: 'Expected an object envelope.' }
  }
  if (envelope.version !== BROWSER_BRIDGE_PROTOCOL_VERSION) {
    return {
      ok: false,
      id,
      code: 'protocol_version_mismatch',
      message: 'Update the Verboo extension and desktop integration to compatible versions.',
    }
  }
  if (
    typeof envelope.id !== 'string' || !envelope.id ||
    !envelope.payload || typeof envelope.payload !== 'object' ||
    Array.isArray(envelope.payload)
  ) {
    return { ok: false, id, code: 'malformed_envelope', message: 'Invalid browser tool request.' }
  }
  if (envelope.kind === 'turnComplete') return { ok: true }
  if (
    envelope.kind !== 'toolRequest' ||
    typeof envelope.payload.name !== 'string' || !envelope.payload.name ||
    !envelope.payload.arguments ||
    typeof envelope.payload.arguments !== 'object' ||
    Array.isArray(envelope.payload.arguments)
  ) {
    return { ok: false, id, code: 'malformed_envelope', message: 'Invalid browser tool request.' }
  }
  return { ok: true }
}

function executionErrorCode(error) {
  switch (error) {
    case 'denied_by_user':
    case 'cancelled':
      return 'approval_rejected'
    case 'timeout':
      return 'approval_timeout'
    case 'approval_ui_unavailable':
      return 'approval_ui_unavailable'
    default:
      return 'execution_failed'
  }
}

function executionErrorMessage(code, fallback) {
  switch (code) {
    case 'approval_ui_unavailable':
      return 'Open the Verboo side panel in Chrome to approve this action.'
    case 'approval_rejected':
      return 'The browser action was not approved in Chrome.'
    case 'approval_timeout':
      return 'The Chrome approval request expired before it was approved.'
    default:
      return fallback || 'The Chrome browser tool failed.'
  }
}

function errorEnvelope(id, code, message) {
  return {
    version: BROWSER_BRIDGE_PROTOCOL_VERSION,
    id,
    kind: 'error',
    payload: { code, message },
  }
}
