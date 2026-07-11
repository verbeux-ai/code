// React hook for hold-to-talk voice input through Verboo's live STT router.
//
// Hold the keybinding to record; release to stop and submit.  Auto-repeat
// key events reset an internal timer — when no keypress arrives within
// RELEASE_TIMEOUT_MS the recording stops automatically. Uses the existing
// audio capture path and the router's AssemblyAI-backed STT endpoint.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSetVoiceState } from '../context/voice.js'
import { useTerminalFocus } from '../ink/hooks/use-terminal-focus.js'
import {
  logEvent,
} from '../services/analytics/index.js'
import { getVoiceKeyterms } from '../services/voiceKeyterms.js'
import {
  connectVoiceStream,
  type FinalizeSource,
  isVoiceStreamAvailable,
  type VoiceStreamConnection,
} from '../services/voiceStreamSTT.js'
import { logForDebugging } from '../utils/debug.js'
import { toError } from '../utils/errors.js'
import { logError } from '../utils/log.js'

// Lazy-loaded voice module. We defer importing voice.ts (and its native
// audio-capture-napi dependency) until voice input is actually activated.
// On macOS, loading the native audio module can trigger a TCC microphone
// permission prompt — we must avoid that until voice input is actually enabled.
type VoiceModule = typeof import('../services/voice.js')
let voiceModule: VoiceModule | null = null

type VoiceState = 'idle' | 'recording' | 'processing'

type UseVoiceOptions = {
  onTranscript: (text: string) => void
  onError?: (message: string) => void
  enabled: boolean
  focusMode: boolean
}

type UseVoiceReturn = {
  state: VoiceState
  handleKeyEvent: (fallbackMs?: number) => void
}

// Gap (ms) between auto-repeat key events that signals key release.
// Terminal auto-repeat typically fires every 30-80ms; 200ms comfortably
// covers jitter while still feeling responsive.
const RELEASE_TIMEOUT_MS = 200

// Fallback (ms) to arm the release timer if no auto-repeat is seen.
// macOS default key repeat delay is ~500ms; 600ms gives headroom.
// If the user tapped and released before auto-repeat started, this
// ensures the release timer gets armed and recording stops.
//
// For modifier-combo first-press activation (handleKeyEvent called at
// t=0, before any auto-repeat), callers should pass FIRST_PRESS_FALLBACK_MS
// instead — the gap to the next keypress is the OS initial repeat *delay*
// (up to ~2s on macOS with slider at "Long"), not the repeat *rate*.
const REPEAT_FALLBACK_MS = 600
export const FIRST_PRESS_FALLBACK_MS = 2000

// How long (ms) to keep a focus-mode session alive without any speech
// before tearing it down to free the WebSocket connection. Re-arms on
// the next focus cycle (blur → refocus).
const FOCUS_SILENCE_TIMEOUT_MS = 5_000

// Number of bars shown in the recording waveform visualizer.
const AUDIO_LEVEL_BARS = 16

// Compute RMS amplitude from a 16-bit signed PCM buffer and return a
// normalized 0-1 value. A sqrt curve spreads quieter levels across more
// of the visual range so the waveform uses the full set of block heights.
export function computeLevel(chunk: Buffer): number {
  const samples = chunk.length >> 1 // 16-bit = 2 bytes per sample
  if (samples === 0) return 0
  let sumSq = 0
  for (let i = 0; i < chunk.length - 1; i += 2) {
    // Read 16-bit signed little-endian
    const sample = ((chunk[i]! | (chunk[i + 1]! << 8)) << 16) >> 16
    sumSq += sample * sample
  }
  const rms = Math.sqrt(sumSq / samples)
  const normalized = Math.min(rms / 2000, 1)
  return Math.sqrt(normalized)
}

export function useVoice({
  onTranscript,
  onError,
  enabled,
  focusMode,
}: UseVoiceOptions): UseVoiceReturn {
  const [state, setState] = useState<VoiceState>('idle')
  const stateRef = useRef<VoiceState>('idle')
  const connectionRef = useRef<VoiceStreamConnection | null>(null)
  const accumulatedRef = useRef('')
  const onTranscriptRef = useRef(onTranscript)
  const onErrorRef = useRef(onError)
  const cleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // True once we've seen a second keypress (auto-repeat) while recording.
  // The OS key repeat delay (~500ms on macOS) means the first keypress is
  // solo — arming the release timer before auto-repeat starts would cause
  // a false release.
  const seenRepeatRef = useRef(false)
  const repeatFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  // True when the current recording session was started by terminal focus
  // (not by a keypress). Focus-driven sessions end on blur, not key release.
  const focusTriggeredRef = useRef(false)
  // Timer that tears down the session after prolonged silence in focus mode.
  const focusSilenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  // Set when a focus-mode session is torn down due to silence. Prevents
  // the focus effect from immediately restarting. Cleared on blur so the
  // next focus cycle re-arms recording.
  const silenceTimedOutRef = useRef(false)
  const recordingStartRef = useRef(0)
  // Incremented on each startRecordingSession(). Callbacks capture their
  // generation and bail if a newer session has started — prevents a zombie
  // slow-connecting WS from an abandoned session from overwriting
  // connectionRef mid-way through the next session.
  const sessionGenRef = useRef(0)
  // Preserved in completion analytics for backwards compatibility. Router
  // sessions are deliberately not retried because each new connection counts
  // against the user's live-STT session budget.
  const retryUsedRef = useRef(false)
  // Bumped when the early-error retry is scheduled. Captured per
  // attemptConnect — onError swallows stale-gen events (conn 1's
  // trailing close-error) but surfaces current-gen ones (conn 2's
  // genuine failure). Same shape as sessionGenRef, one level down.
  const attemptGenRef = useRef(0)
  // Running total of chars flushed in focus mode (each final transcript is
  // injected immediately and accumulatedRef reset). Added to transcriptChars
  // in the completed event so focus-mode sessions don't false-positive as
  // silent-drops (transcriptChars=0 despite successful transcription).
  const focusFlushedCharsRef = useRef(0)
  // True if at least one audio chunk with non-trivial signal was received.
  // Used to distinguish "microphone is silent/inaccessible" from "speech not detected".
  const hasAudioSignalRef = useRef(false)
  // True once onReady fired for the current session. Unlike connectionRef
  // (which cleanup() nulls), this survives effect-order races where Effect 3
  // cleanup runs before Effect 2's finishRecording() — e.g. /voice toggled
  // off mid-recording in focus mode. Used for the wsConnected analytics
  // dimension and error-message branching. Reset in startRecordingSession.
  const everConnectedRef = useRef(false)
  const audioLevelsRef = useRef<number[]>([])
  const isFocused = useTerminalFocus()
  const setVoiceState = useSetVoiceState()

  // Keep callback refs current without triggering re-renders
  onTranscriptRef.current = onTranscript
  onErrorRef.current = onError

  function updateState(newState: VoiceState): void {
    stateRef.current = newState
    setState(newState)
    setVoiceState(prev => {
      if (prev.voiceState === newState) return prev
      return { ...prev, voiceState: newState }
    })
  }

  const cleanup = useCallback((): void => {
    // Stale any in-flight session (main connection isStale(), replay
    // isStale(), finishRecording continuation). Without this, disabling
    // voice during the replay window lets the stale replay open a WS,
    // accumulate transcript, and inject it after voice was torn down.
    sessionGenRef.current++
    if (cleanupTimerRef.current) {
      clearTimeout(cleanupTimerRef.current)
      cleanupTimerRef.current = null
    }
    if (releaseTimerRef.current) {
      clearTimeout(releaseTimerRef.current)
      releaseTimerRef.current = null
    }
    if (repeatFallbackTimerRef.current) {
      clearTimeout(repeatFallbackTimerRef.current)
      repeatFallbackTimerRef.current = null
    }
    if (focusSilenceTimerRef.current) {
      clearTimeout(focusSilenceTimerRef.current)
      focusSilenceTimerRef.current = null
    }
    silenceTimedOutRef.current = false
    voiceModule?.stopRecording()
    if (connectionRef.current) {
      connectionRef.current.close()
      connectionRef.current = null
    }
    accumulatedRef.current = ''
    audioLevelsRef.current = []
    setVoiceState(prev => {
      if (prev.voiceInterimTranscript === '' && !prev.voiceAudioLevels.length)
        return prev
      return { ...prev, voiceInterimTranscript: '', voiceAudioLevels: [] }
    })
  }, [setVoiceState])

  function finishRecording(): void {
    logForDebugging(
      '[voice] finishRecording: stopping recording, transitioning to processing',
    )
    // Session ending — stale any in-flight attempt so its late onError
    // (conn 2 responding after user released key) doesn't double-fire on
    // top of the "check network" message below.
    attemptGenRef.current++
    // Capture focusTriggered BEFORE clearing it — needed as an event dimension
    // so BigQuery can filter out passive focus-mode auto-recordings (user focused
    // terminal without speaking → ambient noise sets hadAudioSignal=true → false
    // silent-drop signature). focusFlushedCharsRef fixes transcriptChars accuracy
    // for sessions WITH speech; focusTriggered enables filtering sessions WITHOUT.
    const focusTriggered = focusTriggeredRef.current
    focusTriggeredRef.current = false
    updateState('processing')
    voiceModule?.stopRecording()
    // Capture duration BEFORE the finalize round-trip so that the WebSocket
    // wait time is not included (otherwise a quick tap looks like > 2s).
    // All ref-backed values are captured here, BEFORE the async boundary —
    // a keypress during the finalize wait can start a new session and reset
    // these refs (e.g. focusFlushedCharsRef = 0 in startRecordingSession),
    // reproducing the silent-drop false-positive this ref exists to prevent.
    const recordingDurationMs = Date.now() - recordingStartRef.current
    const hadAudioSignal = hasAudioSignalRef.current
    const retried = retryUsedRef.current
    const focusFlushedChars = focusFlushedCharsRef.current
    // wsConnected distinguishes "backend received audio but dropped it" (the
    // bug backend PR #287008 fixes) from "WS handshake never completed" —
    // in the latter case audio is still in audioBuffer, never reached the
    // server, but hasAudioSignalRef is already true from ambient noise.
    const wsConnected = everConnectedRef.current
    // Capture generation BEFORE the .then() — if a new session starts during
    // the finalize wait, sessionGenRef has already advanced by the time the
    // continuation runs, so capturing inside the .then() would yield the new
    // session's gen and every staleness check would be a no-op.
    const myGen = sessionGenRef.current
    const isStale = () => sessionGenRef.current !== myGen
    logForDebugging('[voice] Recording stopped')

    // Send finalize and wait for the WebSocket to close before reading the
    // accumulated transcript.  The close handler promotes any unreported
    // interim text to final, so we must wait for it to fire.
    const finalizePromise: Promise<FinalizeSource | undefined> =
      connectionRef.current
        ? connectionRef.current.finalize()
        : Promise.resolve(undefined)

    void finalizePromise
      .then(() => {
        if (isStale()) return

        const text = accumulatedRef.current.trim()
        logForDebugging(
          `[voice] Final transcript assembled (${String(text.length)} chars): "${text.slice(0, 200)}"`,
        )

        logEvent('tengu_voice_recording_completed', {
          transcriptChars: text.length + focusFlushedChars,
          recordingDurationMs,
          hadAudioSignal,
          retried,
          silentDropRetried: false,
          wsConnected,
          focusTriggered,
        })

        if (connectionRef.current) {
          connectionRef.current.close()
          connectionRef.current = null
        }

        if (text) {
          logForDebugging(
            `[voice] Injecting transcript (${String(text.length)} chars)`,
          )
          onTranscriptRef.current(text)
        } else if (focusFlushedChars === 0 && recordingDurationMs > 2000) {
          // Only warn about empty transcript if nothing was flushed in focus
          // mode either, and recording was > 2s (short recordings = accidental
          // taps → silently return to idle).
          if (!wsConnected) {
            // WS never connected → audio never reached backend. Not a silent
            // drop; a connection failure (slow OAuth refresh, network, etc).
            onErrorRef.current?.(
              'Voice connection failed. Check your network and try again.',
            )
          } else if (!hadAudioSignal) {
            // Distinguish silent mic (capture issue) from speech not recognized.
            onErrorRef.current?.(
              'No audio detected from microphone. Check that the correct input device is selected and that Verboo Code has microphone access.',
            )
          } else {
            onErrorRef.current?.('No speech detected.')
          }
        }

        accumulatedRef.current = ''
        setVoiceState(prev => {
          if (prev.voiceInterimTranscript === '') return prev
          return { ...prev, voiceInterimTranscript: '' }
        })
        updateState('idle')
      })
      .catch(err => {
        logError(toError(err))
        if (!isStale()) updateState('idle')
      })
  }

  // When voice is enabled, lazy-import voice.ts so checkRecordingAvailability
  // et al. are ready when the user presses the voice key. Do NOT preload the
  // native module — require('audio-capture.node') is a synchronous dlopen of
  // CoreAudio/AudioUnit that blocks the event loop for ~1s (warm) to ~8s
  // (cold coreaudiod). setImmediate doesn't help: it yields one tick, then the
  // dlopen still blocks. The first voice keypress pays the dlopen cost instead.
  useEffect(() => {
    if (enabled && !voiceModule) {
      void import('../services/voice.js').then(mod => {
        voiceModule = mod
      })
    }
  }, [enabled])

  // ── Focus silence timer ────────────────────────────────────────────
  // Arms (or resets) a timer that tears down the focus-mode session
  // after FOCUS_SILENCE_TIMEOUT_MS of no speech. Called when a session
  // starts and after each flushed transcript.
  function armFocusSilenceTimer(): void {
    if (focusSilenceTimerRef.current) {
      clearTimeout(focusSilenceTimerRef.current)
    }
    focusSilenceTimerRef.current = setTimeout(
      (
        focusSilenceTimerRef,
        stateRef,
        focusTriggeredRef,
        silenceTimedOutRef,
        finishRecording,
      ) => {
        focusSilenceTimerRef.current = null
        if (stateRef.current === 'recording' && focusTriggeredRef.current) {
          logForDebugging(
            '[voice] Focus silence timeout — tearing down session',
          )
          silenceTimedOutRef.current = true
          finishRecording()
        }
      },
      FOCUS_SILENCE_TIMEOUT_MS,
      focusSilenceTimerRef,
      stateRef,
      focusTriggeredRef,
      silenceTimedOutRef,
      finishRecording,
    )
  }

  // ── Focus-driven recording ──────────────────────────────────────────
  // In focus mode, start recording when the terminal gains focus and
  // stop when it loses focus. This enables a "multi-scaring army"
  // workflow where voice input follows window focus.
  useEffect(() => {
    if (!enabled || !focusMode) {
      // Focus mode was disabled while a focus-driven recording was active —
      // stop the recording so it doesn't linger until the silence timer fires.
      if (focusTriggeredRef.current && stateRef.current === 'recording') {
        logForDebugging(
          '[voice] Focus mode disabled during recording, finishing',
        )
        finishRecording()
      }
      return
    }
    let cancelled = false
    if (
      isFocused &&
      stateRef.current === 'idle' &&
      !silenceTimedOutRef.current
    ) {
      const beginFocusRecording = (): void => {
        // Re-check conditions — state or enabled/focusMode may have changed
        // during the await (effect cleanup sets cancelled).
        if (
          cancelled ||
          stateRef.current !== 'idle' ||
          silenceTimedOutRef.current
        )
          return
        logForDebugging('[voice] Focus gained, starting recording session')
        focusTriggeredRef.current = true
        void startRecordingSession()
        armFocusSilenceTimer()
      }
      if (voiceModule) {
        beginFocusRecording()
      } else {
        // Voice module is loading (async import resolves from cache as a
        // microtask). Wait for it before starting the recording session.
        void import('../services/voice.js').then(mod => {
          voiceModule = mod
          beginFocusRecording()
        })
      }
    } else if (!isFocused) {
      // Clear the silence timeout flag on blur so the next focus
      // cycle re-arms recording.
      silenceTimedOutRef.current = false
      if (stateRef.current === 'recording') {
        logForDebugging('[voice] Focus lost, finishing recording')
        finishRecording()
      }
    }
    return () => {
      cancelled = true
    }
  }, [enabled, focusMode, isFocused])

  // ── Start a new recording session (voice_stream connect + audio) ──
  async function startRecordingSession(): Promise<void> {
    if (!voiceModule) {
      onErrorRef.current?.(
        'Voice module not loaded yet. Try again in a moment.',
      )
      return
    }

    // Transition to 'recording' synchronously, BEFORE any await. Callers
    // read state synchronously right after `void startRecordingSession()`:
    // - useVoiceIntegration.tsx space-hold guard reads voiceState from the
    //   store immediately — if it sees 'idle' it clears isSpaceHoldActiveRef
    //   and space auto-repeat leaks into the text input (100% repro)
    // - handleKeyEvent's `currentState === 'idle'` re-entry check below
    // If an await runs first, both see stale 'idle'. See PR #20873 review.
    updateState('recording')
    recordingStartRef.current = Date.now()
    accumulatedRef.current = ''
    seenRepeatRef.current = false
    hasAudioSignalRef.current = false
    retryUsedRef.current = false
    focusFlushedCharsRef.current = 0
    everConnectedRef.current = false
    const myGen = ++sessionGenRef.current

    // ── Pre-check: can we actually record audio? ──────────────
    const availability = await voiceModule.checkRecordingAvailability()
    if (!availability.available) {
      logForDebugging(
        `[voice] Recording not available: ${availability.reason ?? 'unknown'}`,
      )
      onErrorRef.current?.(
        availability.reason ?? 'Audio recording is not available.',
      )
      cleanup()
      updateState('idle')
      return
    }

    logForDebugging(
      '[voice] Starting recording session, connecting voice stream',
    )
    // Clear any previous error
    setVoiceState(prev => {
      if (!prev.voiceError) return prev
      return { ...prev, voiceError: null }
    })

    // Buffer audio chunks while the WebSocket connects. Once the connection
    // is ready (onReady fires), buffered chunks are flushed and subsequent
    // chunks are sent directly.
    const audioBuffer: Buffer[] = []

    // Start recording IMMEDIATELY — audio is buffered until the WebSocket
    // opens, eliminating the 1-2s latency from waiting for OAuth + WS connect.
    logForDebugging(
      '[voice] startRecording: buffering audio while WebSocket connects',
    )
    audioLevelsRef.current = []
    const started = await voiceModule.startRecording(
      (chunk: Buffer) => {
        // Own the chunk before buffering or sending it. Native audio modules
        // may reuse their backing buffer before the WebSocket consumes it.
        const owned = Buffer.from(chunk)
        if (connectionRef.current) {
          connectionRef.current.send(owned)
        } else {
          audioBuffer.push(owned)
        }
        // Update audio level histogram for the recording visualizer
        const level = computeLevel(chunk)
        if (!hasAudioSignalRef.current && level > 0.01) {
          hasAudioSignalRef.current = true
        }
        const levels = audioLevelsRef.current
        if (levels.length >= AUDIO_LEVEL_BARS) {
          levels.shift()
        }
        levels.push(level)
        // Copy the array so React sees a new reference
        const snapshot = [...levels]
        audioLevelsRef.current = snapshot
        setVoiceState(prev => ({ ...prev, voiceAudioLevels: snapshot }))
      },
      () => {
        // External end (e.g. device error) - treat as stop
        if (stateRef.current === 'recording') {
          finishRecording()
        }
      },
      { silenceDetection: false },
    )

    if (!started) {
      logError(new Error('[voice] Recording failed — no audio tool found'))
      onErrorRef.current?.(
        'Failed to start audio capture. Check that your microphone is accessible.',
      )
      cleanup()
      updateState('idle')
      setVoiceState(prev => ({
        ...prev,
        voiceError: 'Recording failed — no audio tool found',
      }))
      return
    }

    logEvent('tengu_voice_recording_started', {
      focusTriggered: focusTriggeredRef.current,
    })

    // Connect WebSocket in parallel with audio recording.
    // Gather keyterms first (async but fast — no model calls), then connect.
    // Bail from callbacks if a newer session has started. Prevents a
    // slow-connecting zombie WS (e.g. user released, pressed again, first
    // WS still handshaking) from firing onReady/onError into the new
    // session and corrupting its connectionRef / triggering a bogus retry.
    const isStale = () => sessionGenRef.current !== myGen

    const attemptConnect = (keyterms: string[]): void => {
      const myAttemptGen = attemptGenRef.current
      void connectVoiceStream(
        {
          onTranscript: (text: string, isFinal: boolean) => {
            if (isStale()) return
            logForDebugging(
              `[voice] onTranscript: isFinal=${String(isFinal)} text="${text}"`,
            )
            if (isFinal && text.trim()) {
              if (focusTriggeredRef.current) {
                // Focus mode: flush each final transcript immediately and
                // keep recording. This gives continuous transcription while
                // the terminal is focused.
                logForDebugging(
                  `[voice] Focus mode: flushing final transcript immediately: "${text.trim()}"`,
                )
                onTranscriptRef.current(text.trim())
                focusFlushedCharsRef.current += text.trim().length
                setVoiceState(prev => {
                  if (prev.voiceInterimTranscript === '') return prev
                  return { ...prev, voiceInterimTranscript: '' }
                })
                accumulatedRef.current = ''
                // User is actively speaking — reset the silence timer.
                armFocusSilenceTimer()
              } else {
                // Hold-to-talk: accumulate final transcripts separated by spaces
                if (accumulatedRef.current) {
                  accumulatedRef.current += ' '
                }
                accumulatedRef.current += text.trim()
                logForDebugging(
                  `[voice] Accumulated final transcript: "${accumulatedRef.current}"`,
                )
                // Clear interim since final supersedes it
                setVoiceState(prev => {
                  const preview = accumulatedRef.current
                  if (prev.voiceInterimTranscript === preview) return prev
                  return { ...prev, voiceInterimTranscript: preview }
                })
              }
            } else if (!isFinal) {
              // Active interim speech resets the focus silence timer.
              // Nova 3 disables auto-finalize so isFinal is never true
              // mid-stream — without this, the 5s timer fires during
              // active speech and tears down the session.
              if (focusTriggeredRef.current) {
                armFocusSilenceTimer()
              }
              // Show accumulated finals + current interim as live preview
              const interim = text.trim()
              const preview = accumulatedRef.current
                ? accumulatedRef.current + (interim ? ' ' + interim : '')
                : interim
              setVoiceState(prev => {
                if (prev.voiceInterimTranscript === preview) return prev
                return { ...prev, voiceInterimTranscript: preview }
              })
            }
          },
          onError: (error: string) => {
            if (isStale()) {
              logForDebugging(
                `[voice] ignoring onError from stale session: ${error}`,
              )
              return
            }
            // Swallow a trailing close-error after the same connection's
            // original error was surfaced below.
            if (attemptGenRef.current !== myAttemptGen) {
              logForDebugging(
                `[voice] ignoring stale onError from superseded attempt: ${error}`,
              )
              return
            }
            // Surfacing — bump gen so this conn's trailing close-error
            // (ws fires error then close 1006) is swallowed above.
            attemptGenRef.current++
            logError(new Error(`[voice] voice STT error: ${error}`))
            onErrorRef.current?.(`Voice stream error: ${error}`)
            // Clear the audio buffer on error to avoid memory leaks
            audioBuffer.length = 0
            focusTriggeredRef.current = false
            cleanup()
            updateState('idle')
          },
          onClose: () => {
            // no-op; lifecycle handled by cleanup()
          },
          onReady: conn => {
            // Only proceed if we're still in recording state AND this is
            // still the current session. A zombie late-connecting WS from
            // an abandoned session can pass the 'recording' check if the
            // user has since started a new session.
            if (isStale() || stateRef.current !== 'recording') {
              conn.close()
              return
            }

            // The WebSocket is now truly open — assign connectionRef so
            // subsequent audio callbacks send directly instead of buffering.
            connectionRef.current = conn
            everConnectedRef.current = true

            // Flush all audio chunks that were buffered while the WebSocket
            // was connecting.  This is safe because onReady fires from the
            // WebSocket 'open' event, guaranteeing send() will not be dropped.
            //
            // Coalesce into ~1s slices rather than one ws.send per chunk
            // — fewer WS frames means less overhead on both ends.
            const SLICE_TARGET_BYTES = 32_000 // ~1s at 16kHz/16-bit/mono
            if (audioBuffer.length > 0) {
              let totalBytes = 0
              for (const c of audioBuffer) totalBytes += c.length
              const slices: Buffer[][] = [[]]
              let sliceBytes = 0
              for (const chunk of audioBuffer) {
                if (
                  sliceBytes > 0 &&
                  sliceBytes + chunk.length > SLICE_TARGET_BYTES
                ) {
                  slices.push([])
                  sliceBytes = 0
                }
                slices[slices.length - 1]!.push(chunk)
                sliceBytes += chunk.length
              }
              logForDebugging(
                `[voice] onReady: flushing ${String(audioBuffer.length)} buffered chunks (${String(totalBytes)} bytes) as ${String(slices.length)} coalesced frame(s)`,
              )
              for (const slice of slices) {
                conn.send(Buffer.concat(slice))
              }
            }
            audioBuffer.length = 0

            // Reset the release timer now that the WebSocket is ready.
            // Only arm it if auto-repeat has been seen — otherwise the OS
            // key repeat delay (~500ms) hasn't elapsed yet and the timer
            // would fire prematurely.
            if (releaseTimerRef.current) {
              clearTimeout(releaseTimerRef.current)
            }
            if (seenRepeatRef.current) {
              releaseTimerRef.current = setTimeout(
                (releaseTimerRef, stateRef, finishRecording) => {
                  releaseTimerRef.current = null
                  if (stateRef.current === 'recording') {
                    finishRecording()
                  }
                },
                RELEASE_TIMEOUT_MS,
                releaseTimerRef,
                stateRef,
                finishRecording,
              )
            }
          },
        },
        {
          keyterms,
        },
      ).then(conn => {
        if (isStale()) {
          conn?.close()
          return
        }
        if (!conn) {
          logForDebugging(
            '[voice] Failed to connect to voice_stream (no OAuth token?)',
          )
          onErrorRef.current?.(
            'Voice mode requires a Verboo account. Please run /login to sign in.',
          )
          // Clear the audio buffer on failure
          audioBuffer.length = 0
          cleanup()
          updateState('idle')
          return
        }

        // Safety check: if the user released the key before connectVoiceStream
        // resolved (but after onReady already ran), close the connection.
        if (stateRef.current !== 'recording') {
          audioBuffer.length = 0
          conn.close()
          return
        }
      })
    }

    void getVoiceKeyterms().then(attemptConnect)
  }

  // ── Hold-to-talk handler ────────────────────────────────────────────
  // Called on every keypress (including terminal auto-repeats while
  // the key is held).  A gap longer than RELEASE_TIMEOUT_MS between
  // events is interpreted as key release.
  //
  // Recording starts immediately on the first keypress to eliminate
  // startup delay.  The release timer is only armed after auto-repeat
  // is detected (to avoid false releases during the OS key repeat
  // delay of ~500ms on macOS).
  const handleKeyEvent = useCallback(
    (fallbackMs = REPEAT_FALLBACK_MS): void => {
      if (!enabled || !isVoiceStreamAvailable()) {
        return
      }

      // In focus mode, recording is driven by terminal focus, not keypresses.
      if (focusTriggeredRef.current) {
        // Active focus recording — ignore key events (session ends on blur).
        return
      }
      if (focusMode && silenceTimedOutRef.current) {
        // Focus session timed out due to silence — keypress re-arms it.
        logForDebugging(
          '[voice] Re-arming focus recording after silence timeout',
        )
        silenceTimedOutRef.current = false
        focusTriggeredRef.current = true
        void startRecordingSession()
        armFocusSilenceTimer()
        return
      }

      const currentState = stateRef.current

      // Ignore keypresses while processing
      if (currentState === 'processing') {
        return
      }

      if (currentState === 'idle') {
        logForDebugging(
          '[voice] handleKeyEvent: idle, starting recording session immediately',
        )
        void startRecordingSession()
        // Fallback: if no auto-repeat arrives within REPEAT_FALLBACK_MS,
        // arm the release timer anyway (the user likely tapped and released).
        repeatFallbackTimerRef.current = setTimeout(
          (
            repeatFallbackTimerRef,
            stateRef,
            seenRepeatRef,
            releaseTimerRef,
            finishRecording,
          ) => {
            repeatFallbackTimerRef.current = null
            if (stateRef.current === 'recording' && !seenRepeatRef.current) {
              logForDebugging(
                '[voice] No auto-repeat seen, arming release timer via fallback',
              )
              seenRepeatRef.current = true
              releaseTimerRef.current = setTimeout(
                (releaseTimerRef, stateRef, finishRecording) => {
                  releaseTimerRef.current = null
                  if (stateRef.current === 'recording') {
                    finishRecording()
                  }
                },
                RELEASE_TIMEOUT_MS,
                releaseTimerRef,
                stateRef,
                finishRecording,
              )
            }
          },
          fallbackMs,
          repeatFallbackTimerRef,
          stateRef,
          seenRepeatRef,
          releaseTimerRef,
          finishRecording,
        )
      } else if (currentState === 'recording') {
        // Second+ keypress while recording — auto-repeat has started.
        seenRepeatRef.current = true
        if (repeatFallbackTimerRef.current) {
          clearTimeout(repeatFallbackTimerRef.current)
          repeatFallbackTimerRef.current = null
        }
      }

      // Reset the release timer on every keypress (including auto-repeats)
      if (releaseTimerRef.current) {
        clearTimeout(releaseTimerRef.current)
      }

      // Only arm the release timer once auto-repeat has been seen.
      // The OS key repeat delay is ~500ms on macOS; without this gate
      // the 200ms timer fires before repeat starts, causing a false release.
      if (stateRef.current === 'recording' && seenRepeatRef.current) {
        releaseTimerRef.current = setTimeout(
          (releaseTimerRef, stateRef, finishRecording) => {
            releaseTimerRef.current = null
            if (stateRef.current === 'recording') {
              finishRecording()
            }
          },
          RELEASE_TIMEOUT_MS,
          releaseTimerRef,
          stateRef,
          finishRecording,
        )
      }
    },
    [enabled, focusMode, cleanup],
  )

  // Cleanup only when disabled or unmounted - NOT on state changes
  useEffect(() => {
    if (!enabled && stateRef.current !== 'idle') {
      cleanup()
      updateState('idle')
    }
    return () => {
      cleanup()
    }
  }, [enabled, cleanup])

  return {
    state,
    handleKeyEvent,
  }
}
