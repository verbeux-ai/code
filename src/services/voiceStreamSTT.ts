// Streaming speech-to-text client used by /voice.
//
// Audio never goes directly to a third-party provider from the CLI. The
// Verboo router authenticates the user, applies the session limit, and owns
// the AssemblyAI credential while this module preserves the existing voice UI
// contract (binary audio in, interim/final text callbacks out).

import type { ClientRequest, IncomingMessage } from 'http'
import WebSocket from 'ws'
import { VERBOO_ROUTER_URL } from '../constants/oauth.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getClaudeAIOAuthTokens,
} from '../utils/auth.js'
import { logForDebugging } from '../utils/debug.js'
import { getUserAgent } from '../utils/http.js'
import { logError } from '../utils/log.js'
import { getWebSocketTLSOptions } from '../utils/mtls.js'
import { getWebSocketProxyAgent, getWebSocketProxyUrl } from '../utils/proxy.js'
import { jsonParse } from '../utils/slowOperations.js'

const KEEPALIVE_MSG = '{"type":"keepalive"}'
const END_STREAM_MSG = '{"type":"end"}'
const KEEPALIVE_INTERVAL_MS = 8_000

// Keep this in sync with the router's hard session cap. The hook stops the
// microphone and lets the final transcript flush before the router's safety
// limit needs to intervene.
export const VOICE_SESSION_LIMIT_MS = 180_000

// The router configures AssemblyAI for 16 kHz, 16-bit, mono PCM. Its
// streaming endpoint accepts input frames from 50 ms through 1 s; native
// capture commonly emits 32 ms chunks, so they must be coalesced here.
const PCM16_BYTES_PER_SECOND = 16_000 * 2
const MIN_AUDIO_FRAME_BYTES = PCM16_BYTES_PER_SECOND / 20 // 50 ms
const MAX_AUDIO_FRAME_BYTES = PCM16_BYTES_PER_SECOND // 1 s

// The router waits for AssemblyAI's Termination event before it sends done.
// This safety cap only protects the CLI from a broken connection during
// finalization; normal sessions resolve through server_done.
export const FINALIZE_TIMEOUTS_MS = {
  safety: 10_000,
  noData: 0,
}

export type VoiceStreamCallbacks = {
  onTranscript: (text: string, isFinal: boolean) => void
  onError: (error: string, opts?: { fatal?: boolean }) => void
  onClose: () => void
  onReady: (connection: VoiceStreamConnection) => void
}

export type FinalizeSource =
  | 'server_done'
  | 'safety_timeout'
  | 'ws_close'
  | 'ws_already_closed'

export type VoiceStreamConnection = {
  send: (audioChunk: Buffer) => void
  finalize: () => Promise<FinalizeSource>
  close: () => void
  isConnected: () => boolean
}

type RouterReady = {
  type: 'ready'
  session_id?: string
}

type RouterTranscript = {
  type: 'transcript'
  text?: string
  final?: boolean
}

type RouterDone = {
  type: 'done'
}

type RouterError = {
  type: 'error'
  code?: string
  message?: string
  retryable?: boolean
}

type RouterMessage = RouterReady | RouterTranscript | RouterDone | RouterError

export function isVoiceStreamAvailable(): boolean {
  return Boolean(getClaudeAIOAuthTokens()?.accessToken)
}

function routerVoiceURL(options?: { keyterms?: string[] }): string {
  // VOICE_STREAM_BASE_URL is intentionally a router /v1 base override for
  // local development, for example ws://localhost:8091/v1. Production uses
  // the same router base as chat completions.
  const base = process.env.VOICE_STREAM_BASE_URL || VERBOO_ROUTER_URL
  const parsed = new URL(`${base.replace(/\/$/, '')}/voice/stt`)
  if (parsed.protocol === 'https:') parsed.protocol = 'wss:'
  if (parsed.protocol === 'http:') parsed.protocol = 'ws:'

  for (const term of options?.keyterms ?? []) {
    parsed.searchParams.append('keyterm', term)
  }
  return parsed.toString()
}

function upgradeErrorMessage(status: number, response?: IncomingMessage): string {
  switch (status) {
    case 401:
      return 'Voice mode requires a valid Verboo session. Please run /login again.'
    case 403:
      return 'Voice mode requires a Verboo user access token. Please run /login again.'
    case 429: {
      const retryAfter = response?.headers['retry-after']
      const seconds = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter
      return seconds
        ? `Voice rate limit reached. Try again in ${seconds}s.`
        : 'Voice rate limit reached. Try again in a moment.'
    }
    case 502:
      return 'Voice transcription service is temporarily unavailable. Try again shortly.'
    case 503:
      return 'Voice service is temporarily unavailable. Try again shortly.'
    default:
      return `Voice WebSocket upgrade rejected with HTTP ${String(status)}`
  }
}

export async function connectVoiceStream(
  callbacks: VoiceStreamCallbacks,
  options?: { keyterms?: string[] },
): Promise<VoiceStreamConnection | null> {
  // Existing startup auth normally refreshes Verboo OAuth before /voice is
  // invoked. Keep this check for sessions that outlive that startup window.
  await checkAndRefreshOAuthTokenIfNeeded()

  const tokens = getClaudeAIOAuthTokens()
  if (!tokens?.accessToken) {
    logForDebugging('[voice] No Verboo OAuth token available')
    return null
  }

  const url = routerVoiceURL(options)
  const headers: Record<string, string> = {
    Authorization: `Bearer ${tokens.accessToken}`,
    'User-Agent': getUserAgent(),
    'x-app': 'cli',
  }
  const tlsOptions = getWebSocketTLSOptions()
  const wsOptions =
    typeof Bun !== 'undefined'
      ? {
          headers,
          proxy: getWebSocketProxyUrl(url),
          tls: tlsOptions || undefined,
        }
      : { headers, agent: getWebSocketProxyAgent(url), ...tlsOptions }

  const ws = new WebSocket(url, wsOptions)
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null
  let connected = false
  let finalized = false
  let finalizing = false
  let upgradeRejected = false
  let lastInterimTranscript = ''
  let resolveFinalize: ((source: FinalizeSource) => void) | null = null
  let pendingAudio = Buffer.alloc(0)

  const resolveFinalization = (source: FinalizeSource): void => {
    if (!resolveFinalize) return
    resolveFinalize(source)
    resolveFinalize = null
  }

  const flushPendingAudio = (padFinalFrame: boolean): void => {
    if (pendingAudio.length === 0 || ws.readyState !== WebSocket.OPEN) return
    if (pendingAudio.length < MIN_AUDIO_FRAME_BYTES && !padFinalFrame) return

    // Preserve a short final phrase by extending it with PCM silence rather
    // than sending an invalid sub-50 ms frame.
    if (pendingAudio.length < MIN_AUDIO_FRAME_BYTES) {
      pendingAudio = Buffer.concat([
        pendingAudio,
        Buffer.alloc(MIN_AUDIO_FRAME_BYTES - pendingAudio.length),
      ])
    }

    while (pendingAudio.length >= MIN_AUDIO_FRAME_BYTES) {
      let frameLength = Math.min(pendingAudio.length, MAX_AUDIO_FRAME_BYTES)
      const remaining = pendingAudio.length - frameLength
      // Never leave a sub-50 ms tail for a subsequent WebSocket frame.
      if (remaining > 0 && remaining < MIN_AUDIO_FRAME_BYTES) {
        frameLength -= MIN_AUDIO_FRAME_BYTES - remaining
      }

      ws.send(pendingAudio.subarray(0, frameLength))
      pendingAudio = pendingAudio.subarray(frameLength)
    }
  }

  const connection: VoiceStreamConnection = {
    send(audioChunk: Buffer): void {
      if (ws.readyState !== WebSocket.OPEN || finalized) return
      // Audio callbacks can hand us pooled N-API buffers. Own the bytes while
      // waiting to form a valid AssemblyAI input frame.
      pendingAudio = Buffer.concat([pendingAudio, Buffer.from(audioChunk)])
      flushPendingAudio(false)
    },
    finalize(): Promise<FinalizeSource> {
      if (finalizing || finalized) {
        return Promise.resolve('ws_already_closed')
      }
      finalizing = true

      return new Promise<FinalizeSource>(resolve => {
        const safetyTimer = setTimeout(
          () => resolveFinalization('safety_timeout'),
          FINALIZE_TIMEOUTS_MS.safety,
        )
        const complete = (source: FinalizeSource): void => {
          clearTimeout(safetyTimer)
          resolve(source)
        }
        resolveFinalize = complete

        if (ws.readyState !== WebSocket.OPEN) {
          pendingAudio = Buffer.alloc(0)
          resolveFinalization('ws_already_closed')
          return
        }
        flushPendingAudio(true)
        finalized = true
        ws.send(END_STREAM_MSG)
      })
    },
    close(): void {
      finalized = true
      connected = false
      pendingAudio = Buffer.alloc(0)
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer)
        keepaliveTimer = null
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    },
    isConnected(): boolean {
      return connected && ws.readyState === WebSocket.OPEN
    },
  }

  ws.on('open', () => {
    logForDebugging('[voice] Router WebSocket connected; waiting for STT readiness')
    ws.send(KEEPALIVE_MSG)
    keepaliveTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN && !finalized) {
        ws.send(KEEPALIVE_MSG)
      }
    }, KEEPALIVE_INTERVAL_MS)
  })

  ws.on('message', (raw: Buffer | string) => {
    let message: RouterMessage
    try {
      message = jsonParse(raw.toString()) as RouterMessage
    } catch {
      return
    }

    switch (message.type) {
      case 'ready':
        if (connected) return
        connected = true
        logForDebugging(`[voice] Router STT ready: ${message.session_id ?? 'unknown'}`)
        callbacks.onReady(connection)
        break

      case 'transcript': {
        const text = message.text ?? ''
        if (!text) return
        const isFinal = message.final === true
        if (isFinal) {
          lastInterimTranscript = ''
        } else {
          lastInterimTranscript = text
        }
        callbacks.onTranscript(text, isFinal)
        break
      }

      case 'done':
        if (lastInterimTranscript) {
          callbacks.onTranscript(lastInterimTranscript, true)
          lastInterimTranscript = ''
        }
        resolveFinalization('server_done')
        if (ws.readyState === WebSocket.OPEN) ws.close()
        break

      case 'error': {
        const detail = message.message ?? message.code ?? 'voice service error'
        logForDebugging(`[voice] Router STT error: ${detail}`)
        if (!finalizing) {
          // The router enforces the session budget, so reconnecting implicitly
          // here would consume another of the user's three allowed sessions.
          callbacks.onError(detail, { fatal: true })
        }
        break
      }
    }
  })

  ws.on('close', (code, reason) => {
    const reasonText = reason.toString()
    connected = false
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer)
      keepaliveTimer = null
    }
    if (lastInterimTranscript) {
      callbacks.onTranscript(lastInterimTranscript, true)
      lastInterimTranscript = ''
    }
    resolveFinalization('ws_close')
    if (!finalizing && !upgradeRejected && code !== 1000 && code !== 1005) {
      callbacks.onError(
        `Voice connection closed: code ${String(code)}${reasonText ? ` — ${reasonText}` : ''}`,
        { fatal: true },
      )
    }
    callbacks.onClose()
  })

  ws.on('unexpected-response', (req: ClientRequest, response: IncomingMessage) => {
    const status = response.statusCode ?? 0
    if (status === 101) return
    upgradeRejected = true
    response.resume()
    req.destroy()
    if (!finalizing) {
      callbacks.onError(upgradeErrorMessage(status, response), { fatal: true })
    }
  })

  ws.on('error', (err: Error) => {
    logError(err)
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer)
      keepaliveTimer = null
    }
    connected = false
    if (!finalizing && !upgradeRejected) {
      callbacks.onError(`Voice connection error: ${err.message}`, { fatal: true })
    }
  })

  return connection
}
