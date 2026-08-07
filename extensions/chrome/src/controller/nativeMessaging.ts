/**
 * Type contract for the packaged Verboo in Chrome MCP bridge implemented by
 * `src/native/bridge.js`.
 */

export const NATIVE_MESSAGING_HOST_NAME = 'com.verboo.code.browser_extension' as const
export const BROWSER_BRIDGE_PROTOCOL_VERSION = 1 as const
export const MAX_HOST_TO_CHROME_BYTES = 1024 * 1024
export const MAX_CHROME_TO_HOST_BYTES = 64 * 1024 * 1024

export type BrowserBridgeMessageKind =
  | 'hello'
  | 'toolRequest'
  | 'turnComplete'
  | 'toolResponse'
  | 'turnCompleteAck'
  | 'error'

export type BrowserBridgeErrorCode =
  | 'approval_rejected'
  | 'approval_timeout'
  | 'approval_ui_unavailable'
  | 'connection_lost'
  | 'execution_failed'
  | 'malformed_envelope'
  | 'protocol_version_mismatch'

export interface BrowserBridgeEnvelope {
  version: typeof BROWSER_BRIDGE_PROTOCOL_VERSION
  id: string
  kind: BrowserBridgeMessageKind
  secret?: string
  payload: unknown
}
