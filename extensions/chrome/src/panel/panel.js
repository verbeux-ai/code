/**
 * panel.js — Verboo Chrome Extension side panel controller.
 *
 * Responsibilities:
 * - Apply i18n strings to the DOM
 * - Render auth status (user-initiated OAuth via MSG.AUTH_LOGIN)
 * - Persist Chrome Permission Mode (manual/skip) via the inline chip
 * - Chat: send user message → AGENT_TURN_START; render agent events
 *   (thought, tool_request, tool_executing, tool_result, turn_complete,
 *   turn_error) as transcript cards
 * - Tool approval prompts: once/always/deny for needsApproval tools
 * - Open the settings page (chrome.runtime.openOptionsPage) from the gear
 * - Surface the desktop connection status ONLY when connected (no
 *   unknown/disconnected noise in the panel chrome)
 *
 * Site Grants live in options.html, not here.
 *
 * Multi-user: zero hardcoded accounts, paths, or tokens.
 */

import { loadMode, saveMode } from '../policy/modesStore.js'
import { getAuthCapabilities, loadSession } from '../auth/auth.js'
import { MSG } from '../controller/protocol.js'
import {
  escapeHtml,
  modelDisplayName,
  safeMarkdownToHtml,
  shouldAppendError,
  shouldSubmitComposerKey,
  structuredResultPreview,
  translatedErrorMessage,
} from './presentation.js'
import { approvalMessage } from './approvalActions.js'
import { stripUntrustedBrowserBoundaryForDisplay } from '../agent/untrustedContent.js'
import { matchSlashQuery, parseSlashInvocation } from '../routines/slashCommands.js'

// ── i18n ────────────────────────────────────────────────────────
import EN_US from '../i18n/en-US.js'
import PT_BR from '../i18n/pt-BR.js'

const approvalSurfacePort = chrome.runtime.connect({ name: 'verboo-approval-surface' })
window.addEventListener('unload', () => approvalSurfacePort.disconnect(), { once: true })

const LOCALE_MAP = {
  'en': EN_US,
  'en-US': EN_US,
  'pt': PT_BR,
  'pt-BR': PT_BR,
}

function pickLocaleBundle() {
  const ui = (chrome.i18n?.getUILanguage?.() ?? 'en') || 'en'
  const base = ui.split('-')[0]
  return LOCALE_MAP[ui] ?? LOCALE_MAP[base] ?? EN_US
}

function t(key) {
  const bundle = pickLocaleBundle()
  return bundle[key]?.message ?? EN_US[key]?.message ?? key
}

function applyI18n(root) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const key = el.getAttribute('data-i18n')
    el.textContent = t(key)
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    const key = el.getAttribute('data-i18n-placeholder')
    el.setAttribute('placeholder', t(key))
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    const key = el.getAttribute('data-i18n-title')
    el.setAttribute('title', t(key))
  }
  for (const el of root.querySelectorAll('[data-i18n-aria-label]')) {
    const key = el.getAttribute('data-i18n-aria-label')
    el.setAttribute('aria-label', t(key))
  }
}

// ── Auth (login-first gate) ───────────────────────────────────────

/**
 * Session is active when accessToken is present and not expired.
 * OAuth accessToken is the source of truth.
 * @param {import('../auth/auth.js').VerbooSession | null | undefined} session
 */
function isSessionActive(session) {
  if (!session?.accessToken) return false
  if (session.expiresAt != null && session.expiresAt <= Date.now()) return false
  return true
}

/**
 * @param {import('../auth/auth.js').VerbooSession | null | undefined} session
 * @returns {string}
 */
function sessionDisplayLabel(session) {
  if (!session) return ''
  if (session.email) return session.email
  if (session.accountId) return session.accountId
  return t('branding_title')
}

/**
 * Toggle login gate vs workspace. Signed-out shows only the login card.
 * Signed-in unlocks the chat workspace.
 * @param {import('../auth/auth.js').VerbooSession | null | undefined} session
 */
function renderAuth(session) {
  const app = document.getElementById('app')
  const workspace = document.getElementById('workspace')
  const signedIn = isSessionActive(session)

  app.dataset.auth = signedIn ? 'signed-in' : 'signed-out'
  if (workspace) workspace.hidden = !signedIn

  // Keep "Verboo" as the only visible brand line. Put account/email on the
  // brand title attribute so it does not wrap ("VerS…") in a narrow panel.
  const brandEl = document.getElementById('topbar-brand')
  const label = signedIn ? sessionDisplayLabel(session) : ''
  if (brandEl) {
    brandEl.title = label || ''
  }
  const userEl = document.getElementById('topbar-user')
  if (userEl) {
    userEl.textContent = ''
    userEl.title = ''
    userEl.hidden = true
  }

  const logoutBtn = document.getElementById('auth-action')
  if (logoutBtn) {
    logoutBtn.dataset.action = 'logout'
    logoutBtn.setAttribute('title', t('auth_logout'))
    logoutBtn.setAttribute('aria-label', t('auth_logout'))
  }

  // Empty chat greeting (CSS :empty::before pulls attr(data-empty))
  const messages = document.getElementById('chat-messages')
  if (messages) messages.dataset.empty = t('chat_greeting')
}

function showLoginError(message) {
  const err = document.getElementById('login-error')
  if (!err) return
  if (message) {
    err.hidden = false
    err.textContent = message
  } else {
    err.hidden = true
    err.textContent = ''
  }
}

/**
 * @param {boolean} loading
 */
function setLoginLoading(loading) {
  const btn = document.getElementById('login-submit')
  if (!btn) return
  btn.disabled = loading || !oauthConfigured
  btn.classList.toggle('is-loading', loading)
  btn.setAttribute('aria-busy', loading ? 'true' : 'false')
  const label = btn.querySelector('.btn-label')
  if (label) {
    label.textContent = loading ? t('auth_loginLoading') : t('auth_login')
  }
}

let oauthConfigured = false

function renderAuthCapabilities(capabilities) {
  oauthConfigured = capabilities?.methods?.includes('oauth') === true &&
    capabilities?.oauthConfigured === true
  const btn = document.getElementById('login-submit')
  if (btn) btn.disabled = !oauthConfigured
  if (!oauthConfigured) showLoginError(t('auth_oauthUnavailable'))
}

/**
 * Promise wrapper around chrome.runtime.sendMessage.
 * @param {Record<string, unknown>} message
 * @returns {Promise<any>}
 */
function sendMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message })
          return
        }
        resolve(response ?? { ok: false, error: 'no response' })
      })
    } catch (err) {
      resolve({ ok: false, error: err?.message ?? String(err) })
    }
  })
}

// ── Model picker ─────────────────────────────────────────────────

/** @type {Array<{ id: string, name?: string, displayName?: string, supportsVision?: boolean, description?: string, provider?: string }>} */
let availableModels = []
let selectedModelId = null
let modelSelectionPending = false

/**
 * @param {Array<{ id: string, name?: string, displayName?: string, supportsVision?: boolean }>} models
 * @param {string | null | undefined} selectedId
 */
function populateModelSelect(models, selectedId) {
  availableModels = Array.isArray(models) ? models.filter((model) => model?.id) : []
  const hasSelected = selectedId && availableModels.some((model) => model.id === selectedId)
  selectedModelId = hasSelected ? selectedId : (availableModels[0]?.id ?? null)
  renderModelPicker()
  updateSendEnabled()
}

function clearModelSelect() {
  availableModels = []
  selectedModelId = null
  modelSelectionPending = false
  closeModelMenu()
  renderModelPicker()
  updateSendEnabled()
}

function renderModelPicker() {
  const picker = document.getElementById('model-picker')
  const trigger = document.getElementById('model-picker-trigger')
  const nameEl = document.getElementById('model-picker-name')
  const metaEl = document.getElementById('model-picker-meta')
  const menu = document.getElementById('model-menu')
  if (!picker || !trigger || !nameEl || !metaEl || !menu) return

  const selected = availableModels.find((model) => model.id === selectedModelId) ?? null
  trigger.disabled = availableModels.length === 0 || modelSelectionPending || turnInFlight
  trigger.setAttribute('aria-busy', modelSelectionPending ? 'true' : 'false')
  nameEl.textContent = selected ? modelDisplayName(selected) : t('model_unavailable')
  metaEl.textContent = selected ? modelMetaText(selected) : t('model_unavailable_help')

  menu.replaceChildren()
  for (const model of availableModels) {
    const option = document.createElement('button')
    option.type = 'button'
    option.className = 'model-option'
    option.setAttribute('role', 'option')
    option.dataset.modelId = model.id
    option.setAttribute('aria-selected', model.id === selectedModelId ? 'true' : 'false')

    const check = document.createElement('span')
    check.className = 'model-option-check'
    check.setAttribute('aria-hidden', 'true')
    check.textContent = '✓'

    const copy = document.createElement('span')
    copy.className = 'model-option-copy'
    const optionName = document.createElement('span')
    optionName.className = 'model-option-name'
    optionName.textContent = modelDisplayName(model)
    const optionMeta = document.createElement('span')
    optionMeta.className = 'model-option-meta'
    optionMeta.textContent = modelMetaText(model)
    copy.append(optionName, optionMeta)

    option.append(check, copy)
    if (model.supportsVision) {
      const capability = document.createElement('span')
      capability.className = 'model-capability'
      capability.textContent = t('model_visual_badge')
      option.appendChild(capability)
    }
    option.addEventListener('click', () => {
      void chooseModel(model.id)
    })
    option.addEventListener('keydown', handleModelOptionKeydown)
    menu.appendChild(option)
  }
}

function modelMetaText(model) {
  if (model.description) return String(model.description).replace(/\s+/g, ' ').trim().slice(0, 92)
  const capability = model.supportsVision
    ? t('model_visual_description')
    : t('model_text_description')
  return model.provider ? `${model.provider} · ${capability}` : capability
}

async function chooseModel(modelId) {
  if (!modelId || modelSelectionPending || turnInFlight || modelId === selectedModelId) {
    closeModelMenu()
    return
  }
  const previousId = selectedModelId
  selectedModelId = modelId
  modelSelectionPending = true
  closeModelMenu()
  renderModelPicker()
  updateSendEnabled()

  const response = await sendMessage({ type: MSG.MODELS_SELECT, modelId })
  modelSelectionPending = false
  if (!response?.ok) {
    selectedModelId = previousId
    renderModelPicker()
    appendTurnError(t('model_selection_failed'))
    updateSendEnabled()
    return
  }
  selectedModelId = response.selectedId || modelId
  renderModelPicker()
  updateSendEnabled()
}

function openModelMenu(focusDirection = 0) {
  const picker = document.getElementById('model-picker')
  const trigger = document.getElementById('model-picker-trigger')
  const menu = document.getElementById('model-menu')
  if (!picker || !trigger || !menu || trigger.disabled) return
  menu.hidden = false
  picker.dataset.open = 'true'
  trigger.setAttribute('aria-expanded', 'true')
  if (focusDirection !== 0) {
    const options = Array.from(menu.querySelectorAll('.model-option'))
    const selectedIndex = options.findIndex((option) => option.getAttribute('aria-selected') === 'true')
    const fallback = focusDirection > 0 ? 0 : options.length - 1
    options[selectedIndex >= 0 ? selectedIndex : fallback]?.focus()
  }
}

function closeModelMenu({ restoreFocus = false } = {}) {
  const picker = document.getElementById('model-picker')
  const trigger = document.getElementById('model-picker-trigger')
  const menu = document.getElementById('model-menu')
  if (!picker || !trigger || !menu) return
  menu.hidden = true
  picker.dataset.open = 'false'
  trigger.setAttribute('aria-expanded', 'false')
  if (restoreFocus) trigger.focus()
}

function handleModelOptionKeydown(event) {
  const options = Array.from(document.querySelectorAll('#model-menu .model-option'))
  const index = options.indexOf(event.currentTarget)
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const delta = event.key === 'ArrowDown' ? 1 : -1
    options[(index + delta + options.length) % options.length]?.focus()
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    options[event.key === 'Home' ? 0 : options.length - 1]?.focus()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    closeModelMenu({ restoreFocus: true })
  }
}

function initModelSelect() {
  const trigger = document.getElementById('model-picker-trigger')
  if (!trigger) return
  trigger.addEventListener('click', () => {
    const isOpen = document.getElementById('model-picker')?.dataset.open === 'true'
    if (isOpen) closeModelMenu()
    else openModelMenu()
  })
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      openModelMenu(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Escape') {
      closeModelMenu()
    }
  })
  document.addEventListener('pointerdown', (event) => {
    if (!document.getElementById('model-picker')?.contains(event.target)) closeModelMenu()
  })
}

async function handleLoginSubmit(event) {
  event.preventDefault()
  showLoginError('')
  if (!oauthConfigured) {
    showLoginError(t('auth_oauthUnavailable'))
    return
  }

  setLoginLoading(true)
  try {
    const response = await sendMessage({
      type: MSG.AUTH_LOGIN,
    })
    if (!response?.ok) {
      showLoginError(response?.error || t('auth_loginFailed'))
      return
    }
    renderAuth(response.session)
    populateModelSelect(response.models ?? [], response.selectedId)
  } catch (err) {
    showLoginError(err?.message ?? t('auth_loginFailed'))
  } finally {
    setLoginLoading(false)
  }
}

async function handleLogout() {
  showLoginError('')
  const response = await sendMessage({ type: MSG.AUTH_LOGOUT })
  if (!response?.ok && response?.error) {
    console.warn('[Verboo panel] logout failed', response.error)
  }
  renderAuth(null)
  clearModelSelect()
  conversationHistory = []
  pendingConversation = null
}

/**
 * Ask the service worker for current auth + models on panel open.
 */
async function hydrateAuthFromBackground() {
  const authRes = await sendMessage({ type: MSG.AUTH_STATE_REQUEST })
  renderAuthCapabilities(authRes?.capabilities ?? getAuthCapabilities())
  if (authRes?.ok && isSessionActive(authRes.session)) {
    renderAuth(authRes.session)
    const modelsRes = await sendMessage({ type: MSG.MODELS_LIST })
    if (modelsRes?.ok) {
      populateModelSelect(modelsRes.models ?? [], modelsRes.selectedId)
    }
    return
  }
  // Fallback: local storage (tests / offline SW race)
  const local = await loadSession()
  if (isSessionActive(local)) {
    renderAuth(local)
    const modelsRes = await sendMessage({ type: MSG.MODELS_LIST })
    if (modelsRes?.ok) {
      populateModelSelect(modelsRes.models ?? [], modelsRes.selectedId)
    }
  } else {
    renderAuth(null)
    clearModelSelect()
  }
}

// ── Mode selector (inline chip next to composer) ────────────────

async function initModes() {
  const mode = await loadMode()
  const radio = document.querySelector(`input[name="mode"][value="${mode}"]`)
  if (radio) radio.checked = true

  for (const input of document.querySelectorAll('input[name="mode"]')) {
    input.addEventListener('change', async (e) => {
      const value = /** @type {HTMLInputElement} */ (e.target).value
      await saveMode(/** @type {any} */ (value))
    })
  }
}

// ── Routines and slash commands ─────────────────────────────────

/** @type {Array<Record<string, any>>} */
let routines = []
/** @type {Array<Record<string, any>>} */
let slashMatches = []
let activeSlashIndex = -1
/** @type {Record<string, any> | null} */
let pendingRoutine = null
/** @type {HTMLElement | null} */
let routineVariableOpener = null
/** @type {Record<string, any>} */
let recordingState = { active: false }
/** @type {ReturnType<typeof setInterval> | null} */
let recordingTimer = null

async function loadRoutines() {
  const response = await sendMessage({ type: MSG.ROUTINE_LIST })
  routines = response?.ok && Array.isArray(response.routines) ? response.routines : []
  const input = document.getElementById('chat-input')
  if (input?.value.startsWith('/')) renderSlashMenu(input.value)
}

function renderSlashMenu(query, forceOpen = false) {
  const menu = document.getElementById('routine-slash-menu')
  const list = document.getElementById('routine-slash-list')
  const trigger = document.getElementById('routines-btn')
  if (!menu || !list || !trigger) return

  slashMatches = matchSlashQuery(query.startsWith('/') ? query : '/', routines)
  if (activeSlashIndex < 0 || activeSlashIndex >= slashMatches.length) {
    activeSlashIndex = slashMatches.length > 0 ? 0 : -1
  }
  list.replaceChildren()

  for (const [index, routine] of slashMatches.entries()) {
    const option = document.createElement('button')
    option.type = 'button'
    option.id = `routine-slash-option-${index}`
    option.className = 'routine-slash-option'
    option.setAttribute('role', 'menuitem')
    option.dataset.active = index === activeSlashIndex ? 'true' : 'false'

    const copy = document.createElement('span')
    copy.className = 'routine-slash-copy'
    const name = document.createElement('span')
    name.className = 'routine-slash-name'
    name.textContent = routine.name
    const description = document.createElement('span')
    description.className = 'routine-slash-description'
    description.textContent = routine.description || routine.instructions
    copy.append(name, description)

    const command = document.createElement('code')
    command.className = 'routine-slash-command'
    command.textContent = `/${routine.command}`
    option.append(copy, command)
    option.addEventListener('pointermove', () => {
      activeSlashIndex = index
      updateActiveSlashOption()
    })
    option.addEventListener('click', () => {
      void chooseRoutine(routine)
    })
    list.appendChild(option)
  }

  const shouldOpen = forceOpen || String(query).startsWith('/')
  menu.hidden = !shouldOpen
  trigger.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false')
  document.getElementById('chat-input')?.setAttribute(
    'aria-expanded',
    shouldOpen ? 'true' : 'false',
  )
  updateActiveSlashOption()
}

function updateActiveSlashOption() {
  const options = document.querySelectorAll('#routine-slash-list .routine-slash-option')
  for (const [index, option] of Array.from(options).entries()) {
    option.dataset.active = index === activeSlashIndex ? 'true' : 'false'
  }
  const active = activeSlashIndex >= 0 ? options[activeSlashIndex] : null
  const input = document.getElementById('chat-input')
  if (active?.id) input?.setAttribute('aria-activedescendant', active.id)
  else input?.removeAttribute('aria-activedescendant')
}

function closeSlashMenu() {
  const menu = document.getElementById('routine-slash-menu')
  if (menu) menu.hidden = true
  document.getElementById('routines-btn')?.setAttribute('aria-expanded', 'false')
  const input = document.getElementById('chat-input')
  input?.setAttribute('aria-expanded', 'false')
  input?.removeAttribute('aria-activedescendant')
  slashMatches = []
  activeSlashIndex = -1
}

function toggleRoutinesMenu() {
  const menu = document.getElementById('routine-slash-menu')
  const input = document.getElementById('chat-input')
  if (!menu || !input) return
  if (!menu.hidden) {
    closeSlashMenu()
  } else {
    activeSlashIndex = 0
    renderSlashMenu(input.value.startsWith('/') ? input.value : '/', true)
    input.focus()
  }
}

function handleSlashKeydown(event) {
  const menu = document.getElementById('routine-slash-menu')
  if (!menu || menu.hidden) return
  if (event.key === 'Escape') {
    event.preventDefault()
    closeSlashMenu()
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (slashMatches.length === 0) return
    const direction = event.key === 'ArrowDown' ? 1 : -1
    activeSlashIndex =
      (activeSlashIndex + direction + slashMatches.length) % slashMatches.length
    updateActiveSlashOption()
    return
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && activeSlashIndex >= 0) {
    event.preventDefault()
    void chooseRoutine(slashMatches[activeSlashIndex])
  }
}

async function chooseRoutine(routine) {
  const input = document.getElementById('chat-input')
  if (input) {
    input.value = ''
    resizeChatInput(input)
  }
  closeSlashMenu()
  updateSendEnabled()

  const requiredVariables = (routine.variables ?? []).filter(
    (variable) => variable.required !== false && !variable.defaultValue,
  )
  if (requiredVariables.length > 0) {
    openVariableDialog(routine, requiredVariables)
    return
  }
  const variables = Object.fromEntries(
    (routine.variables ?? []).map((variable) => [variable.name, variable.defaultValue ?? '']),
  )
  await runRoutine(routine, variables)
}

function openVariableDialog(routine, variables) {
  const dialog = document.getElementById('routine-variable-dialog')
  const fields = document.getElementById('routine-variable-fields')
  if (!dialog || !fields) return
  routineVariableOpener = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null
  pendingRoutine = routine
  fields.replaceChildren()
  document.getElementById('routine-variable-description').textContent =
    routine.description || `/${routine.command}`
  setVariableError('')

  for (const variable of variables) {
    const label = document.createElement('label')
    label.className = 'routine-variable-field'
    const caption = document.createElement('span')
    caption.textContent = variable.name
    const field = document.createElement('input')
    field.className = 'field-input'
    field.name = variable.name
    field.required = true
    field.autocomplete = 'off'
    label.append(caption, field)
    fields.appendChild(label)
  }
  dialog.showModal()
  fields.querySelector('input')?.focus()
}

function closeVariableDialog() {
  pendingRoutine = null
  document.getElementById('routine-variable-dialog')?.close()
}

async function submitRoutineVariables(event) {
  event.preventDefault()
  if (!pendingRoutine) return
  const form = event.currentTarget
  const values = Object.fromEntries(new FormData(form).entries())
  const variables = Object.fromEntries(
    (pendingRoutine.variables ?? []).map((variable) => [
      variable.name,
      values[variable.name] ?? variable.defaultValue ?? '',
    ]),
  )
  if (Object.values(variables).some((value) => !String(value).trim())) {
    setVariableError(t('routine_variables_required'))
    return
  }
  const routine = pendingRoutine
  closeVariableDialog()
  await runRoutine(routine, variables)
}

async function runRoutine(routine, variables) {
  const response = await sendMessage({
    type: MSG.ROUTINE_RUN,
    routineId: routine.id,
    expectedRevision: routine.revision,
    variables,
  })
  if (!response?.ok) {
    appendTurnError(response?.error ?? t('routine_run_failed'))
    return
  }
  const runId = response.run?.id
  if (runId) {
    appendUserMessage(`/${routine.command}`)
    activeTurnId = runId
    setTurnInFlight(true)
    ensureWorkingHeader()
    armTurnWatchdogs(runId)
  }
}

function setVariableError(message) {
  const error = document.getElementById('routine-variable-error')
  if (!error) return
  error.hidden = !message
  error.textContent = message
}

function openRoutineSettings() {
  closeSlashMenu()
  void chrome.tabs.create({
    url: chrome.runtime.getURL('src/panel/options.html#routines'),
  })
}

async function toggleWorkflowRecording() {
  const button = document.getElementById('record-workflow')
  if (button) button.disabled = true
  const response = recordingState.active
    ? await sendMessage({ type: MSG.ROUTINE_RECORD_STOP })
    : await sendMessage({ type: MSG.ROUTINE_RECORD_START })
  if (button) button.disabled = false
  if (!response?.ok) {
    appendTurnError(
      translatedErrorMessage(response?.error, 'routine_record_failed', t),
    )
    return
  }
  if (response.draftId) openRoutineDraft(response.draftId)
  if (response.state) renderRecordingState(response.state)
}

async function cancelWorkflowRecording() {
  const response = await sendMessage({ type: MSG.ROUTINE_RECORD_CANCEL })
  if (!response?.ok) {
    appendTurnError(
      translatedErrorMessage(response?.error, 'routine_record_failed', t),
    )
  }
}

function renderRecordingState(state) {
  recordingState = state?.active ? state : { active: false }
  const status = document.getElementById('recording-status')
  const button = document.getElementById('record-workflow')
  if (status) status.hidden = !recordingState.active
  if (button) {
    button.dataset.recording = recordingState.active ? 'true' : 'false'
    button.setAttribute('aria-pressed', recordingState.active ? 'true' : 'false')
    button.setAttribute(
      'title',
      recordingState.active ? t('routine_record_stop') : t('routine_record'),
    )
    button.setAttribute(
      'aria-label',
      recordingState.active ? t('routine_record_stop') : t('routine_record'),
    )
  }
  if (recordingTimer != null) {
    clearInterval(recordingTimer)
    recordingTimer = null
  }
  updateRecordingTime()
  if (recordingState.active) {
    recordingTimer = setInterval(updateRecordingTime, 1_000)
  }
}

function updateRecordingTime() {
  const time = document.getElementById('recording-time')
  if (!time) return
  const elapsed = recordingState.active
    ? Math.max(0, Date.now() - Number(recordingState.startedAt ?? Date.now()))
    : 0
  const seconds = Math.floor(elapsed / 1_000)
  const minutes = Math.floor(seconds / 60)
  time.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

async function initRoutines() {
  await loadRoutines()
  document.getElementById('routines-btn')?.addEventListener('click', toggleRoutinesMenu)
  document.getElementById('record-workflow')?.addEventListener('click', () => {
    void toggleWorkflowRecording()
  })
  document.getElementById('recording-cancel')?.addEventListener('click', () => {
    void cancelWorkflowRecording()
  })
  document.getElementById('routine-manage')?.addEventListener('click', openRoutineSettings)
  document.getElementById('routine-variable-form')?.addEventListener('submit', (event) => {
    void submitRoutineVariables(event)
  })
  for (const id of ['routine-variable-close', 'routine-variable-cancel']) {
    document.getElementById(id)?.addEventListener('click', closeVariableDialog)
  }
  document.getElementById('routine-variable-dialog')?.addEventListener('close', () => {
    pendingRoutine = null
    ;(routineVariableOpener ?? document.getElementById('chat-input'))?.focus()
    routineVariableOpener = null
  })
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === MSG.ROUTINE_STATE_CHANGED) void loadRoutines()
    if (message?.type === MSG.ROUTINE_RECORD_STATE_CHANGED) {
      renderRecordingState(message.state)
    }
  })
  const recordingResponse = await sendMessage({
    type: MSG.ROUTINE_RECORD_STATE_REQUEST,
  })
  if (recordingResponse?.ok) renderRecordingState(recordingResponse.state)
}

// ── Chat transcript ──────────────────────────────────────────────
//
// Verboo activity model (one current action + optional compact details):
//   - user bubble
//   - [Working…] header (pulse) while the turn is in flight
//   - activity lines: Navigating… / Clicking… / Reading page…
//   - tool_request card only for needsApproval / hard denial
//   - soft activity-ok / activity-err for normal tool results
//   - assistant bubble (turn_complete) — natural message only
//   - turn_error bubble

/** @type {Map<string, HTMLElement>} card by toolCallId */
const toolCards = new Map()

/** @type {HTMLElement | null} live "Working…" header for the current turn */
let workingHeaderEl = null
/** @type {HTMLElement | null} */
let activityCurrentEl = null
/** @type {HTMLElement | null} */
let activityDetailsEl = null
/** @type {HTMLButtonElement | null} */
let activityToggleEl = null
/** @type {string[]} */
let activityHistory = []

function appendUserMessage(text) {
  const messages = document.getElementById('chat-messages')
  const msg = document.createElement('div')
  msg.className = 'chat-message'
  msg.dataset.role = 'user'
  const content = document.createElement('div')
  content.className = 'chat-message-content'
  content.textContent = text
  msg.appendChild(content)
  if (!String(text).startsWith('/')) {
    msg.appendChild(routineDraftAction(
      t('routine_save_message'),
      (button) => createDraftFromMessage(text, button),
    ))
  }
  messages.appendChild(msg)
  messages.scrollTop = messages.scrollHeight
}

function appendAssistantMessage(text, hasToolActivity = true) {
  if (hasToolActivity) finishActivitySummary('complete')
  else removeActivitySummary()
  const messages = document.getElementById('chat-messages')
  const msg = document.createElement('div')
  msg.className = 'chat-message'
  msg.dataset.role = 'assistant'
  const content = document.createElement('div')
  content.className = 'chat-message-content'
  content.innerHTML = safeMarkdownToHtml(text)
  msg.append(
    content,
    routineDraftAction(
      t('routine_convert_conversation'),
      createDraftFromConversation,
    ),
  )
  messages.appendChild(msg)
  messages.scrollTop = messages.scrollHeight
}

function routineDraftAction(label, handler) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'chat-message-routine-action'
  button.textContent = label
  button.addEventListener('click', () => void handler(button))
  return button
}

async function createDraftFromMessage(text, button) {
  button.disabled = true
  const response = await sendMessage({
    type: MSG.ROUTINE_DRAFT_FROM_MESSAGE,
    text,
  })
  button.disabled = false
  if (!response?.ok) {
    appendTurnError(response?.error ?? t('routine_draft_failed'))
    return
  }
  openRoutineDraft(response.draftId)
}

async function createDraftFromConversation(button) {
  button.disabled = true
  const response = await sendMessage({
    type: MSG.ROUTINE_DRAFT_FROM_CONVERSATION,
    history: conversationHistory,
  })
  button.disabled = false
  if (!response?.ok) {
    appendTurnError(response?.error ?? t('routine_draft_failed'))
    return
  }
  openRoutineDraft(response.draftId)
}

function openRoutineDraft(draftId) {
  void chrome.tabs.create({
    url: chrome.runtime.getURL(
      `src/panel/options.html#routines?draft=${encodeURIComponent(draftId)}`,
    ),
  })
}

/** Remove transient thinking UI when the model answered without browser tools. */
function removeActivitySummary() {
  workingHeaderEl?.remove()
  workingHeaderEl = null
  activityCurrentEl = null
  activityDetailsEl = null
  activityToggleEl = null
  activityHistory = []
}

/**
 * Ensure a single pulsing "Working…" header exists for the current turn.
 */
function ensureWorkingHeader() {
  if (workingHeaderEl && document.contains(workingHeaderEl)) return
  const messages = document.getElementById('chat-messages')
  if (!messages) return
  const el = document.createElement('div')
  el.className = 'activity-working'
  el.setAttribute('aria-live', 'polite')
  const row = document.createElement('div')
  row.className = 'activity-summary-row'
  const glyph = document.createElement('span')
  glyph.className = 'activity-working-glyph'
  glyph.setAttribute('aria-hidden', 'true')
  const label = document.createElement('span')
  label.className = 'activity-current'
  label.textContent = t('activity_working')
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'activity-details-toggle'
  toggle.hidden = true
  toggle.dataset.count = '0'
  toggle.setAttribute('aria-expanded', 'false')
  toggle.textContent = t('activity_details').replace('{count}', '0')
  const details = document.createElement('div')
  details.className = 'activity-details'
  details.hidden = true
  toggle.addEventListener('click', () => {
    const open = details.hidden
    details.hidden = !open
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false')
    toggle.textContent = open
      ? t('activity_hide_details')
      : t('activity_details').replace('{count}', toggle.dataset.count || '0')
  })
  row.append(glyph, label, toggle)
  el.append(row, details)
  messages.appendChild(el)
  workingHeaderEl = el
  activityCurrentEl = label
  activityDetailsEl = details
  activityToggleEl = toggle
  activityHistory = []
  messages.scrollTop = messages.scrollHeight
}

/**
 * Preserve one collapsed summary when the turn ends, then release references
 * so the next turn creates its own activity block.
 * @param {'complete'|'error'|'stopped'} state
 */
function finishActivitySummary(state) {
  if (!workingHeaderEl) return
  workingHeaderEl.classList.toggle('is-complete', state === 'complete')
  workingHeaderEl.classList.toggle('is-stopped', state !== 'complete')
  if (activityCurrentEl) {
    if (state === 'complete') {
      const count = Math.max(activityHistory.length, 1)
      activityCurrentEl.textContent = t(
        count === 1 ? 'activity_step_completed' : 'activity_steps_completed',
      ).replace('{count}', String(count))
    } else if (state === 'stopped') {
      activityCurrentEl.textContent = t('activity_stopped')
    } else {
      activityCurrentEl.textContent = t('activity_incomplete')
    }
  }
  if (activityDetailsEl) activityDetailsEl.hidden = true
  if (activityToggleEl) {
    activityToggleEl.setAttribute('aria-expanded', 'false')
    activityToggleEl.textContent = t('activity_details')
      .replace('{count}', activityToggleEl.dataset.count || '0')
  }
  workingHeaderEl = null
  activityCurrentEl = null
  activityDetailsEl = null
  activityToggleEl = null
  activityHistory = []
}

/**
 * Append a quiet human activity line.
 * @param {string} text
 * @param {'ok' | 'err' | null} [variant]
 */
function appendActivityLine(text, variant) {
  if (!text) return
  ensureWorkingHeader()
  const messages = document.getElementById('chat-messages')
  if (!messages || !activityDetailsEl || !activityCurrentEl) return
  if (activityHistory.at(-1) === text) return
  activityCurrentEl.textContent = text
  activityHistory.push(text)
  const line = document.createElement('div')
  line.className = 'activity-line'
  if (variant === 'ok') line.classList.add('activity-ok')
  if (variant === 'err') line.classList.add('activity-err')
  line.textContent = text
  activityDetailsEl.appendChild(line)
  if (activityToggleEl) {
    activityToggleEl.hidden = activityHistory.length < 2
    activityToggleEl.dataset.count = String(activityHistory.length)
    if (activityToggleEl.getAttribute('aria-expanded') !== 'true') {
      activityToggleEl.textContent = t('activity_details')
        .replace('{count}', String(activityHistory.length))
    }
  }
  messages.scrollTop = messages.scrollHeight
}

/**
 * Turn raw agent thought dumps into short human activity lines.
 * Returns null when the thought should not be shown (step counters, etc.).
 * @param {string} text
 * @returns {string | null}
 */
function humanizeThought(text) {
  if (!text || typeof text !== 'string') return null
  const raw = text.trim()
  if (!raw) return null

  // Soft progress — show something so Working… isn't the only signal during long router waits.
  if (/^Step \d+\/\d+/i.test(raw)) return t('activity_continuing')

  if (/Calling navigate/i.test(raw)) {
    const m = raw.match(/→\s*(\S+?)(?:…|\.\.\.)?\s*$/)
    const short = m ? shortUrl(m[1]) : ''
    if (short) return t('activity_navigating').replace('{url}', short)
    return 'Navigating…'
  }
  if (/Calling click/i.test(raw)) return t('activity_clicking')
  if (/Calling type/i.test(raw)) return t('activity_typing')
  if (/Calling screenshot/i.test(raw)) return t('activity_capturing')
  if (/Calling read_page/i.test(raw)) return t('activity_reading')

  if (/Analyzing request/i.test(raw)) return t('activity_analyzing')

  if (/LLM agent unavailable/i.test(raw)) return t('activity_quick_planner')
  if (/Router error after|finishing with what we have/i.test(raw)) {
    return t('activity_finishing_partial')
  }

  if (/^Planning \d+ tool call\(s\)/i.test(raw)) return t('activity_planning')
  if (/^No tool action/i.test(raw)) return t('activity_thinking')
  if (/Injected strategy hint/i.test(raw)) return t('activity_retrying')
  return null
}

/**
 * Short host + path for activity lines (no protocol, no query bloat).
 * @param {string} url
 * @returns {string}
 */
function shortUrl(url) {
  if (!url) return ''
  let cleaned = String(url).replace(/…$/, '').replace(/\.\.\.$/, '')
  try {
    const u = new URL(cleaned)
    let out = u.hostname.replace(/^www\./i, '')
    if (out.length > 40) out = out.slice(0, 37) + '…'
    return out
  } catch {
    cleaned = cleaned.replace(/^https?:\/\//i, '').replace(/\/$/, '')
    if (cleaned.length > 48) cleaned = cleaned.slice(0, 45) + '…'
    return cleaned
  }
}

function appendTurnError(text) {
  finishActivitySummary('error')
  const messages = document.getElementById('chat-messages')
  const previous = messages.lastElementChild
  const previousError = previous?.classList.contains('chat-error')
    ? previous.textContent
    : ''
  if (!shouldAppendError(previousError, text)) {
    messages.scrollTop = messages.scrollHeight
    return
  }
  const bubble = document.createElement('div')
  bubble.className = 'chat-message chat-error'
  bubble.dataset.role = 'assistant'
  bubble.textContent = text
  messages.appendChild(bubble)
  messages.scrollTop = messages.scrollHeight
}

function riskBadgeClass(risk) {
  switch (risk) {
    case 'read': return 'risk-read'
    case 'mutate': return 'risk-mutate'
    case 'elevated': return 'risk-elevated'
    default: return 'risk-mutate'
  }
}

function riskLabel(risk) {
  switch (risk) {
    case 'read': return t('risk_read')
    case 'mutate': return t('risk_mutate')
    case 'elevated': return t('risk_elevated')
    default: return risk
  }
}

function toolNameLabel(name) {
  // i18n lookup with fallback to the raw tool name.
  const key = `tool_name_${name}`
  const bundle = pickLocaleBundle()
  return bundle[key]?.message ?? EN_US[key]?.message ?? name
}

function renderToolCard(toolCall, policyDecision) {
  const messages = document.getElementById('chat-messages')
  const card = document.createElement('div')
  card.className = 'tool-card'
  card.dataset.toolCallId = toolCall.id
  card.dataset.state = policyDecision?.needsApproval ? 'awaiting' : (policyDecision?.reason === 'hard_block' || policyDecision?.reason === 'site_denied' ? 'denied' : 'info')

  // Header: tool name + risk badge
  const header = document.createElement('div')
  header.className = 'tool-card-header'
  const name = document.createElement('span')
  name.className = 'tool-card-name'
  name.textContent = toolNameLabel(toolCall.name)
  const badge = document.createElement('span')
  badge.className = `risk-badge ${riskBadgeClass(toolCall.risk)}`
  badge.textContent = riskLabel(toolCall.risk)
  header.append(name, badge)
  card.appendChild(header)

  // Params
  const params = document.createElement('div')
  params.className = 'tool-card-params'
  params.textContent = formatParams(toolCall)
  card.appendChild(params)

  // Reasoning (if any)
  if (toolCall.reasoning) {
    const reasoning = document.createElement('div')
    reasoning.className = 'tool-card-reasoning'
    reasoning.textContent = toolCall.reasoning
    card.appendChild(reasoning)
  }

  // Policy reason
  if (policyDecision?.reason) {
    const reason = document.createElement('div')
    reason.className = 'tool-card-policy'
    reason.dataset.reason = policyDecision.reason
    reason.textContent = policyReasonLabel(policyDecision)
    card.appendChild(reason)
  }

  // Approval actions (only when needsApproval)
  if (policyDecision?.needsApproval) {
    const actions = document.createElement('div')
    actions.className = 'tool-card-actions'

    const denyBtn = document.createElement('button')
    denyBtn.type = 'button'
    denyBtn.className = 'btn btn-secondary tool-deny'
    denyBtn.textContent = t('tool_deny')
    denyBtn.addEventListener('click', () => {
      void chrome.runtime.sendMessage({
        type: MSG.TOOL_DENY,
        toolCallId: toolCall.id,
        reason: 'user_denied',
      })
    })

    const onceBtn = document.createElement('button')
    onceBtn.type = 'button'
    onceBtn.className = 'btn btn-secondary tool-once'
    onceBtn.textContent = t('siteGrants_allowOnce')
    onceBtn.addEventListener('click', () => {
      void chrome.runtime.sendMessage(approvalMessage(toolCall.id, 'once'))
    })

    const alwaysBtn = document.createElement('button')
    alwaysBtn.type = 'button'
    alwaysBtn.className = 'btn btn-primary tool-always'
    alwaysBtn.textContent = t('siteGrants_alwaysAllow')
    alwaysBtn.addEventListener('click', () => {
      void chrome.runtime.sendMessage(approvalMessage(toolCall.id, 'always'))
    })

    actions.append(denyBtn, onceBtn, alwaysBtn)
    card.appendChild(actions)
  }

  messages.appendChild(card)
  messages.scrollTop = messages.scrollHeight
  toolCards.set(toolCall.id, card)
  return card
}

function markToolExecuting(toolCallId, toolName) {
  const card = toolCards.get(toolCallId)
  if (!card) return
  card.dataset.state = 'executing'

  // Replace actions with executing indicator
  const actions = card.querySelector('.tool-card-actions')
  if (actions) actions.remove()

  const executing = document.createElement('div')
  executing.className = 'tool-card-executing'
  executing.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${t('tool_executing')}</span>`
  card.appendChild(executing)
}

function renderToolResult(toolResult) {
  const card = toolCards.get(toolResult.toolCallId)
  const messages = document.getElementById('chat-messages')

  // Approval / hard-denial cards keep a compact result note on the card.
  // Normal auto-run tools use quiet activity lines (not green JSON boxes).
  if (card) {
    const chip = document.createElement('div')
    chip.className = `tool-result-chip ${toolResult.success ? 'success' : 'error'}`
    const label = toolResult.success
      ? t('tool_result_success')
      : t('tool_result_error')
    const detail = toolResult.success
      ? formatResultData(toolResult.data)
      : formatErrorLine(toolResult.error)
    chip.innerHTML = `<span class="tool-result-label">${label}</span><span class="tool-result-detail">${escapeHtml(detail)}</span>`

    const executing = card.querySelector('.tool-card-executing')
    if (executing) executing.remove()
    card.dataset.state = toolResult.success ? 'done' : 'failed'
    card.appendChild(chip)
    messages.scrollTop = messages.scrollHeight
    return
  }

  if (!toolResult.success) {
    appendActivityLine(formatErrorLine(toolResult.error) || t('tool_result_error'), 'err')
  }
}

function closeApprovalCard(toolCallId, decision) {
  const card = toolCards.get(toolCallId)
  if (!card) return
  // If still awaiting (user responded), remove action buttons
  const actions = card.querySelector('.tool-card-actions')
  if (actions) {
    const note = document.createElement('div')
    note.className = 'tool-card-closed'
    note.textContent = decision === 'deny'
      ? t('tool_denied')
      : decision === 'cancelled'
        ? t('tool_cancelled')
        : t('tool_approved')
    actions.replaceWith(note)
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function formatParams(toolCall) {
  const p = toolCall.params
  if (!p || typeof p !== 'object') return toolCall.input || ''
  try {
    return Object.entries(p)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ')
  } catch {
    return toolCall.input || ''
  }
}

/**
 * Short human summary of a tool result payload — never dump raw JSON/selectors.
 * @param {unknown} data
 * @returns {string}
 */
function formatResultData(data) {
  if (data == null) return ''

  const displayData = stripUntrustedBrowserBoundaryForDisplay(data)
  if (displayData !== data) return formatResultData(displayData)

  // dataUrl / base64 blobs
  if (typeof data === 'string') {
    if (
      data.startsWith('data:image') ||
      /^Screenshot captured/i.test(data) ||
      (data.length > 200 && /^[A-Za-z0-9+/=\s]+$/.test(data.slice(0, 400)))
    ) {
      return 'Screenshot captured'
    }
    if (
      /permission|screenshot|capture/i.test(data) &&
      /error|denied|fail|could not|blocked/i.test(data)
    ) {
      return t('activity_capture_failed')
    }
    if (looksLikeScriptNoise(data)) return 'Page content not useful'
    // Soften accidental JSON strings
    const trimmed = data.trim()
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        return formatResultData(JSON.parse(trimmed))
      } catch {
        // fall through
      }
    }
    return data.slice(0, 120)
  }

  if (typeof data === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (data)
    if (obj.image || obj.dataUrl || obj.base64) return 'Screenshot captured'
    const structuredPreview = structuredResultPreview(data)
    if (structuredPreview) return structuredPreview
    if (typeof obj.text === 'string') {
      if (looksLikeScriptNoise(obj.text)) return 'Page content not useful'
      // Prefer a short clip of useful page text
      const clip = obj.text.replace(/\s+/g, ' ').trim().slice(0, 100)
      return clip || t('activity_reading')
    }
    // Objects with selector/url keys → short summary, no full selector dump
    if ('url' in obj || 'selector' in obj || 'ok' in obj) {
      const parts = []
      if (typeof obj.url === 'string' && obj.url) parts.push(shortUrl(obj.url))
      if (obj.ok === false) parts.push(t('tool_result_error'))
      else if (parts.length === 0) parts.push(t('tool_result_success'))
      return parts.join(' · ')
    }
    try {
      const s = JSON.stringify(data)
      if (s.length > 80) return t('tool_result_success')
      return s
    } catch {
      return ''
    }
  }

  return String(data).slice(0, 120)
}

/**
 * One soft line for tool errors.
 * @param {unknown} error
 * @returns {string}
 */
function formatErrorLine(error) {
  if (error == null) return ''
  const s = String(error)
  if (
    /permission|screenshot|capture/i.test(s) &&
    /error|denied|fail|could not|blocked/i.test(s)
  ) {
    return t('activity_capture_failed')
  }
  if (s.startsWith('hard_block:')) return t('policy_hard_block')
  if (s === 'site_denied') return t('policy_site_denied')
  if (s === 'denied_by_user') return t('tool_denied')
  if (s === 'cancelled') return t('tool_cancelled')
  // Strip noisy CSS selectors from errors
  return s
    .replace(/\s*→\s*(?![hH][tT][tT][pP][sS]?:)[^\s…]+(?:…)?/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 140)
}

/**
 * Detect minified script / SPA dumps that are useless in the chat chip
 * (e.g. YouTube body textContent full of ytcsi / function noise).
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeScriptNoise(text) {
  if (!text || typeof text !== 'string') return false
  const sample = text.slice(0, 4000)
  if (/\bytcsi\b|ytcfg\.set|window\[["']yt/i.test(sample)) return true
  // Dense braces/semicolons typical of minified JS blobs.
  if (sample.length >= 200) {
    const symbols = (sample.match(/[{};=]/g) || []).length
    if (symbols / sample.length > 0.08) return true
  }
  return false
}

function policyReasonLabel(decision) {
  switch (decision.reason) {
    case 'hard_block':
      return `${t('policy_hard_block')}: ${decision.hardBlockLabel ?? 'unknown'}`
    case 'site_denied':
      return t('policy_site_denied')
    case 'site_always_allowed':
      return t('policy_site_always_allowed')
    case 'site_once_allowed':
      return t('policy_site_once_allowed')
    case 'manual_needs_approval':
      return t('policy_manual_needs_approval')
    case 'elevated_requires_approval':
      return t('policy_elevated_requires_approval')
    case 'auto_no_grant':
      return t('policy_auto_no_grant')
    case 'skip_no_grant':
      return t('policy_skip_no_grant')
    default:
      return decision.reason
  }
}

// ── Chat send ────────────────────────────────────────────────────

/** True while an agent turn is in flight (disables the send button). */
let turnInFlight = false

/** Bounded context sent with the next model turn while this panel stays open. */
const MAX_PANEL_HISTORY_MESSAGES = 12
/** @type {Array<{role:'user'|'assistant', content:string}>} */
let conversationHistory = []
/** @type {{turnId:string, userMessage:string} | null} */
let pendingConversation = null

/** @type {{id:string, tabId:number, frameId:number, text:string, verification:'pending'|'complete'|'incomplete'} | null} */
let pendingSelectionContext = null

/** @type {string | null} turn currently owned by the panel UI */
let activeTurnId = null

/** Idle ms without agent events → declare background dead (router is 60s). */
const TURN_IDLE_MS = 90_000
/** Hard cap even if events keep arriving. */
const TURN_MAX_MS = 15 * 60_000
const CHAT_INPUT_MAX_HEIGHT = 120

/** @type {ReturnType<typeof setTimeout> | null} */
let turnIdleTimer = null
/** @type {ReturnType<typeof setTimeout> | null} */
let turnMaxTimer = null

function updateSendEnabled() {
  const input = document.getElementById('chat-input')
  const send = document.getElementById('chat-send')
  if (!input || !send) return
  const hasText = input.value.trim().length > 0
  send.disabled = turnInFlight || modelSelectionPending || !selectedModelId || !hasText
}

function isSelectionContext(context) {
  return Boolean(
    context &&
    typeof context.id === 'string' &&
    Number.isInteger(context.tabId) &&
    Number.isInteger(context.frameId) &&
    typeof context.text === 'string' &&
    ['pending', 'complete', 'incomplete'].includes(context.verification),
  )
}

function renderSelectionContext() {
  const container = document.getElementById('selection-context')
  const preview = document.getElementById('selection-context-preview')
  const warning = document.getElementById('selection-context-warning')
  const remove = document.getElementById('selection-context-remove')
  if (!container || !preview || !warning || !remove) return

  const context = pendingSelectionContext
  container.hidden = !context
  if (!context) {
    preview.textContent = ''
    warning.textContent = ''
    warning.hidden = true
    remove.disabled = false
    return
  }

  preview.textContent = context.text.replace(/\s+/g, ' ').trim()
  warning.hidden = context.verification === 'complete'
  warning.textContent = context.verification === 'pending'
    ? t('selection_context_verifying')
    : t('selection_context_incomplete')
  remove.disabled = false
}

function setSelectionContext(context) {
  if (!isSelectionContext(context)) return
  pendingSelectionContext = context
  renderSelectionContext()
}

function clearSelectionContext() {
  pendingSelectionContext = null
  renderSelectionContext()
}

async function resolveSelectionContextTabId() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (Number.isInteger(tab?.id)) return tab.id
  } catch {
    // Fall back to the current window for older Chrome window focus behavior.
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    return Number.isInteger(tab?.id) ? tab.id : null
  } catch {
    return null
  }
}

async function hydrateSelectionContext() {
  const tabId = await resolveSelectionContextTabId()
  if (!Number.isInteger(tabId)) return
  const response = await sendMessage({ type: MSG.SELECTION_CONTEXT_GET, tabId })
  if (!response?.ok) return
  if (isSelectionContext(response.context)) {
    setSelectionContext(response.context)
  } else {
    clearSelectionContext()
  }
}

async function handleSelectionContextChanged(context) {
  const tabId = await resolveSelectionContextTabId()
  if (tabId !== context.tabId) return
  setSelectionContext(context)
}

function initSelectionContext() {
  const remove = document.getElementById('selection-context-remove')
  remove?.addEventListener('click', async () => {
    const context = pendingSelectionContext
    if (!context) return
    remove.disabled = true
    const response = await sendMessage({
      type: MSG.SELECTION_CONTEXT_DISCARD,
      tabId: context.tabId,
      selectionContextId: context.id,
    })
    if (response?.ok) clearSelectionContext()
    else remove.disabled = false
  })
  void hydrateSelectionContext()
  chrome.tabs.onActivated.addListener(() => {
    void hydrateSelectionContext()
  })
}

function resizeChatInput(input) {
  input.style.height = 'auto'
  const scrollHeight = input.scrollHeight
  input.style.height = `${Math.min(scrollHeight, CHAT_INPUT_MAX_HEIGHT)}px`
  input.dataset.overflow = scrollHeight > CHAT_INPUT_MAX_HEIGHT ? 'true' : 'false'
}

function setTurnInFlight(inFlight) {
  turnInFlight = Boolean(inFlight)
  if (turnInFlight) closeModelMenu()
  const send = document.getElementById('chat-send')
  const stop = document.getElementById('chat-stop')
  const clear = document.getElementById('clear-chat')
  if (send) send.hidden = turnInFlight
  if (stop) {
    stop.hidden = !turnInFlight
    if (!turnInFlight) stop.disabled = false
  }
  if (clear) clear.disabled = turnInFlight
  renderModelPicker()
  updateSendEnabled()
}

function clearConversation() {
  if (turnInFlight) return

  conversationHistory = []
  pendingConversation = null
  toolCards.clear()
  removeActivitySummary()
  document.getElementById('chat-messages')?.replaceChildren()
  document.getElementById('chat-input')?.focus()
}

function clearTurnWatchdogs() {
  if (turnIdleTimer != null) {
    clearTimeout(turnIdleTimer)
    turnIdleTimer = null
  }
  if (turnMaxTimer != null) {
    clearTimeout(turnMaxTimer)
    turnMaxTimer = null
  }
}

/**
 * End the in-flight turn in the panel (Working… off, send re-enabled).
 * Does not append a message — caller does that.
 */
function endTurnUi() {
  clearTurnWatchdogs()
  activeTurnId = null
  setTurnInFlight(false)
}

/**
 * Watch for a silent service worker / hung router so Working… cannot stick forever.
 * Idle timer resets on every agent event for this turn.
 * @param {string} turnId
 */
function armTurnWatchdogs(turnId) {
  clearTurnWatchdogs()
  activeTurnId = turnId

  const failIdle = () => {
    if (activeTurnId !== turnId || !turnInFlight) return
    endTurnUi()
    appendTurnError(t('chat_turnIdleTimeout'))
    void chrome.runtime.sendMessage({ type: MSG.AGENT_TURN_CANCEL, turnId }).catch(() => {})
  }
  const failMax = () => {
    if (activeTurnId !== turnId || !turnInFlight) return
    endTurnUi()
    appendTurnError(t('chat_turnMaxTimeout'))
    void chrome.runtime.sendMessage({ type: MSG.AGENT_TURN_CANCEL, turnId }).catch(() => {})
  }

  turnIdleTimer = setTimeout(failIdle, TURN_IDLE_MS)
  turnMaxTimer = setTimeout(failMax, TURN_MAX_MS)
}

/** Reset idle watchdog when the background is still producing events. */
function bumpTurnIdleWatchdog() {
  if (!turnInFlight || !activeTurnId) return
  const turnId = activeTurnId
  if (turnIdleTimer != null) clearTimeout(turnIdleTimer)
  turnIdleTimer = setTimeout(() => {
    if (activeTurnId !== turnId || !turnInFlight) return
    endTurnUi()
    appendTurnError(t('chat_turnIdleTimeout'))
    void chrome.runtime.sendMessage({ type: MSG.AGENT_TURN_CANCEL, turnId }).catch(() => {})
  }, TURN_IDLE_MS)
}

function initChat() {
  const form = document.getElementById('chat-form')
  const input = document.getElementById('chat-input')
  const stop = document.getElementById('chat-stop')

  input.addEventListener('input', () => {
    resizeChatInput(input)
    updateSendEnabled()
    if (input.value.startsWith('/')) {
      renderSlashMenu(input.value)
    } else {
      closeSlashMenu()
    }
  })
  input.addEventListener('keydown', (event) => {
    handleSlashKeydown(event)
    if (!shouldSubmitComposerKey(event)) return
    event.preventDefault()
    form.requestSubmit()
  })
  resizeChatInput(input)
  updateSendEnabled()

  stop?.addEventListener('click', async () => {
    if (!turnInFlight || !activeTurnId) return
    stop.disabled = true
    appendActivityLine(t('activity_stopping'))
    await sendMessage({ type: MSG.AGENT_TURN_CANCEL, turnId: activeTurnId })
  })

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) return
    // Ignore double-submit while a turn is already running.
    if (turnInFlight) return

    const slashInvocation = parseSlashInvocation(text)
    if (slashInvocation) {
      const routine = routines.find((item) => item.command === slashInvocation.command)
      if (routine) {
        await chooseRoutine(routine)
        return
      }
    }

    input.value = ''
    resizeChatInput(input)
    closeSlashMenu()
    updateSendEnabled()

    const authState = await sendMessage({ type: MSG.AUTH_STATE_REQUEST })
    const session = authState?.session ?? await loadSession()
    if (!isSessionActive(session)) {
      appendTurnError(t('chat_signInRequired'))
      return
    }

    appendUserMessage(text)

    const turnId = crypto.randomUUID()
    const priorConversation = conversationHistory.slice(-MAX_PANEL_HISTORY_MESSAGES)
    const selectionContextForTurn = pendingSelectionContext
    pendingConversation = { turnId, userMessage: text }
    setTurnInFlight(true)
    ensureWorkingHeader()
    armTurnWatchdogs(turnId)
    try {
      const response = await chrome.runtime.sendMessage({
        type: MSG.AGENT_TURN_START,
        turnId,
        userMessage: text,
        modelId: selectedModelId,
        conversationHistory: priorConversation,
        ...(selectionContextForTurn
          ? {
              selectionContextId: selectionContextForTurn.id,
              selectionContextTabId: selectionContextForTurn.tabId,
            }
          : {}),
      })
      if (!response?.ok) throw new Error(response?.error ?? t('chat_turnStartFailed'))
      if (selectionContextForTurn?.id === pendingSelectionContext?.id) {
        clearSelectionContext()
      }
    } catch (err) {
      if (pendingConversation?.turnId === turnId) pendingConversation = null
      endTurnUi()
      appendTurnError(err?.message ?? t('chat_turnStartFailed'))
    }
  })
}

// ── Agent event listener ─────────────────────────────────────────

function handleToolRequest(message) {
  if (!message.toolCall?.id) return

  if (message.policyDecision?.needsApproval) {
    if (message.turnId && !activeTurnId) {
      activeTurnId = message.turnId
      setTurnInFlight(true)
      ensureWorkingHeader()
    }
    // Approval can sit open longer than idle timeout — pause idle, keep absolute max.
    if (turnIdleTimer != null) {
      clearTimeout(turnIdleTimer)
      turnIdleTimer = null
    }
  } else {
    bumpTurnIdleWatchdog()
  }

  // A notification may broadcast while hydration is also running.
  if (toolCards.has(message.toolCall.id)) return
  renderToolCard(message.toolCall, message.policyDecision)
}

async function hydratePendingApprovals() {
  const response = await sendMessage({ type: MSG.TOOL_PENDING_LIST })
  if (!response?.ok || !Array.isArray(response.approvals)) return
  for (const approval of response.approvals) {
    handleToolRequest(approval)
  }
}

function initAgentEventListener() {
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return

    switch (message.type) {
      case MSG.AUTH_STATE_CHANGED: {
        renderAuth(message.session ?? null)
        if (!isSessionActive(message.session)) {
          clearModelSelect()
        }
        break
      }
      case MSG.MODELS_STATE_CHANGED: {
        populateModelSelect(message.models ?? [], message.selectedId)
        break
      }
      case MSG.SELECTION_CONTEXT_CHANGED: {
        if (!isSelectionContext(message.context)) break
        void handleSelectionContextChanged(message.context)
        break
      }
      case MSG.AGENT_TURN_STARTED: {
        // Background confirmed the turn — keep Working… and reset idle clock.
        if (message.turnId && activeTurnId && message.turnId !== activeTurnId) break
        ensureWorkingHeader()
        bumpTurnIdleWatchdog()
        break
      }
      case MSG.AGENT_THOUGHT: {
        ensureWorkingHeader()
        bumpTurnIdleWatchdog()
        const humanized = humanizeThought(message.text)
        if (humanized) appendActivityLine(humanized)
        break
      }
      case MSG.AGENT_TOOL_REQUEST: {
        handleToolRequest(message)
        break
      }
      case MSG.AGENT_TOOL_EXECUTING: {
        bumpTurnIdleWatchdog()
        markToolExecuting(message.toolCallId, message.toolName)
        break
      }
      case MSG.AGENT_TOOL_RESULT: {
        bumpTurnIdleWatchdog()
        renderToolResult(message.toolResult)
        break
      }
      case 'agent:approval_closed': {
        bumpTurnIdleWatchdog()
        closeApprovalCard(message.approvalId, message.decision)
        break
      }
      case MSG.AGENT_TURN_COMPLETE: {
        if (message.turnId && activeTurnId && message.turnId !== activeTurnId) break
        const completed = pendingConversation?.turnId === message.turnId
          ? pendingConversation
          : null
        endTurnUi()
        appendAssistantMessage(
          message.assistantMessage,
          Array.isArray(message.toolResults) && message.toolResults.length > 0,
        )
        if (completed) {
          conversationHistory.push(
            { role: 'user', content: completed.userMessage },
            { role: 'assistant', content: String(message.assistantMessage ?? '') },
          )
          conversationHistory = conversationHistory.slice(-MAX_PANEL_HISTORY_MESSAGES)
          pendingConversation = null
        }
        break
      }
      case MSG.AGENT_TURN_ERROR: {
        if (message.turnId && activeTurnId && message.turnId !== activeTurnId) break
        if (pendingConversation?.turnId === message.turnId) pendingConversation = null
        endTurnUi()
        if (message.error === 'cancelled' || message.error === 'Turn cancelled.') {
          finishActivitySummary('stopped')
        } else {
          appendTurnError(message.error)
        }
        break
      }
      case MSG.ROUTINE_RUN_CHANGED: {
        const run = message.run
        if (!run?.id || (activeTurnId && run.id !== activeTurnId)) break
        if (run.status === 'queued' || run.status === 'running') {
          bumpTurnIdleWatchdog()
          break
        }
        if (run.status === 'waiting_approval') {
          if (turnIdleTimer != null) {
            clearTimeout(turnIdleTimer)
            turnIdleTimer = null
          }
          break
        }
        if (run.status === 'completed') {
          endTurnUi()
          appendAssistantMessage(run.assistantMessage || t('activity_done_short'))
        } else if (run.status === 'failed') {
          endTurnUi()
          appendTurnError(run.error || t('routine_run_failed'))
        } else if (run.status === 'cancelled') {
          endTurnUi()
          finishActivitySummary('stopped')
        }
        break
      }
      default:
        break
    }
  })
}

function openSettings() {
  // chrome.runtime.openOptionsPage falls back to options.html if no
  // options_ui is declared in the manifest.
  void chrome.runtime.openOptionsPage()
}

function openPrivacy() {
  void chrome.tabs.create({ url: chrome.runtime.getURL('privacy.html') })
}

// ── Init ─────────────────────────────────────────────────────────

function resolveBrandAssets() {
  // Extension-root paths so mascot/icons resolve regardless of panel nesting.
  const mascot = chrome.runtime.getURL('icons/verboo-mascot.png')
  for (const img of document.querySelectorAll('.login-mascot, .topbar-mascot')) {
    img.src = mascot
  }
}

async function init() {
  applyI18n(document)
  resolveBrandAssets()

  initAgentEventListener()
  initModelSelect()
  initSelectionContext()

  await hydrateAuthFromBackground()
  await hydratePendingApprovals()

  await initModes()
  initChat()
  await initRoutines()

  document.getElementById('login-form')?.addEventListener('submit', (e) => {
    void handleLoginSubmit(e)
  })
  document.getElementById('auth-action')?.addEventListener('click', () => {
    void handleLogout()
  })
  document.getElementById('settings-btn')?.addEventListener('click', openSettings)
  document.getElementById('clear-chat')?.addEventListener('click', clearConversation)

  document.getElementById('privacy-link-login')?.addEventListener('click', openPrivacy)

  // Backup if AUTH_STATE_CHANGED broadcast is missed (e.g. race).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    if ('verbooSession' in changes) {
      renderAuth(changes.verbooSession.newValue ?? null)
      if (!isSessionActive(changes.verbooSession.newValue)) {
        clearModelSelect()
      }
    }
  })
}

init().catch((err) => {
  console.error('[Verboo panel] init failed', err)
})
