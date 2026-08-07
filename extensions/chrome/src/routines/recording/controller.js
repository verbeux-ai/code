import { recordedEventsToDraft, sanitizeRecordedEvent } from './sanitize.js'

export const RECORDING_STORAGE_KEY = 'verbooActiveRecordingV1'

export function createRecordingController({
  storage,
  sendToTab,
  onState,
  cryptoImpl = globalThis.crypto,
  now = Date.now,
}) {
  async function state() {
    const result = await storage.get(RECORDING_STORAGE_KEY)
    return result?.[RECORDING_STORAGE_KEY] ?? null
  }

  async function start(accountId, tabId) {
    if (!accountId) throw new Error('auth_required')
    if (!Number.isInteger(tabId)) throw new Error('routine_recording_tab_required')
    if (await state()) throw new Error('routine_recording_active')
    const recording = {
      id: cryptoImpl.randomUUID(),
      accountId,
      tabId,
      startedAt: now(),
      events: [],
    }
    await sendToTab(tabId, { type: 'routine:recorder_enable' })
    await storage.set({ [RECORDING_STORAGE_KEY]: recording })
    onState(publicState(recording))
    return publicState(recording)
  }

  async function recordEvent(tabId, event) {
    const recording = await state()
    if (!recording || recording.tabId !== tabId) return false
    const sanitized = sanitizeRecordedEvent(event)
    if (!sanitized) return false
    recording.events = [...recording.events, sanitized].slice(-500)
    await storage.set({ [RECORDING_STORAGE_KEY]: recording })
    onState(publicState(recording))
    return true
  }

  async function stop(accountId) {
    const recording = await state()
    if (!recording || recording.accountId !== accountId) {
      throw new Error('routine_recording_not_found')
    }
    const draft = recordedEventsToDraft(recording.events)
    await storage.remove(RECORDING_STORAGE_KEY)
    await sendToTab(recording.tabId, { type: 'routine:recorder_disable' }).catch(() => {})
    onState({ active: false })
    return { draft, recordingId: recording.id }
  }

  async function cancel(accountId) {
    const recording = await state()
    if (!recording || recording.accountId !== accountId) return false
    await storage.remove(RECORDING_STORAGE_KEY)
    await sendToTab(recording.tabId, { type: 'routine:recorder_disable' }).catch(() => {})
    onState({ active: false })
    return true
  }

  async function reinject(tabId) {
    const recording = await state()
    if (!recording || recording.tabId !== tabId) return false
    await sendToTab(tabId, { type: 'routine:recorder_enable' }).catch(() => {})
    return true
  }

  return { start, recordEvent, stop, cancel, state, reinject }
}

function publicState(recording) {
  return {
    active: true,
    id: recording.id,
    tabId: recording.tabId,
    startedAt: recording.startedAt,
    eventCount: recording.events.length,
  }
}
