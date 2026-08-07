/**
 * options.js — Verboo Chrome Extension options page.
 *
 * Minimal settings page opened via chrome.runtime.openOptionsPage.
 * Owns: full permission mode selector, site grants CRUD, sign-out,
 * and privacy link.
 */

import { loadMode, saveMode } from '../policy/modesStore.js'
import { loadGrants, upsertGrant, removeGrant } from '../policy/siteGrantsStore.js'
import { loadSession } from '../auth/auth.js'
import { MSG } from '../controller/protocol.js'
import { loadOptionsSession } from './optionsSession.js'

import EN_US from '../i18n/en-US.js'
import PT_BR from '../i18n/pt-BR.js'

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
    el.textContent = t(el.getAttribute('data-i18n'))
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')))
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')))
  }
  for (const el of root.querySelectorAll('[data-i18n-aria-label]')) {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')))
  }
}

// ── Auth ────────────────────────────────────────────────────────

/**
 * @param {import('../auth/auth.js').VerbooSession | null | undefined} session
 */
function isSessionActive(session) {
  if (!session?.accessToken) return false
  if (session.expiresAt != null && session.expiresAt <= Date.now()) return false
  return true
}

async function renderAuth(session) {
  const sub = document.getElementById('options-user')
  if (!sub) return
  if (isSessionActive(session)) {
    const label = session.email || session.accountId || t('branding_title')
    sub.textContent = `${t('auth_signedInAs')} ${label}`
  } else {
    sub.textContent = t('auth_notSignedIn')
  }
}

/**
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

async function handleLogout() {
  await sendMessage({ type: MSG.AUTH_LOGOUT })
  await renderAuth(null)
}

// ── Mode selector ───────────────────────────────────────────────

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

// ── Site grants ─────────────────────────────────────────────────

function normalizeHost(raw) {
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed) return ''
  return trimmed
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
}

function decisionLabel(decision) {
  switch (decision) {
    case 'always': return t('siteGrants_alwaysAllow')
    case 'once': return t('siteGrants_allowOnce')
    case 'deny': return t('siteGrants_deny')
    default: return decision
  }
}

async function renderGrants() {
  const grants = await loadGrants()
  const list = document.getElementById('grants-list')
  list.innerHTML = ''
  for (const grant of grants) {
    const li = document.createElement('li')
    li.className = 'grant-item'

    const host = document.createElement('span')
    host.className = 'grant-host'
    host.textContent = grant.host
    host.title = grant.host

    const decision = document.createElement('span')
    decision.className = 'grant-decision'
    decision.dataset.decision = grant.decision
    decision.textContent = decisionLabel(grant.decision)

    const remove = document.createElement('button')
    remove.className = 'grant-remove'
    remove.type = 'button'
    remove.textContent = '×'
    remove.setAttribute('aria-label', t('siteGrants_remove'))
    remove.title = t('siteGrants_remove')
    remove.addEventListener('click', async () => {
      await removeGrant(grant.host)
      await renderGrants()
    })

    li.append(host, decision, remove)
    list.appendChild(li)
  }
}

async function handleAddGrant() {
  const input = document.getElementById('grants-host-input')
  const select = document.getElementById('grants-decision-select')
  const host = normalizeHost(input.value)
  if (!host) return
  const decision = select.value
  await upsertGrant(host, decision)
  input.value = ''
  await renderGrants()
}

// ── Routines and Skills ─────────────────────────────────────────

/** @type {Array<Record<string, any>>} */
let routines = []
/** @type {Record<string, any> | null} */
let editorRoutine = null
/** @type {Array<Record<string, any>>} */
let routineRuns = []
/** @type {HTMLElement | null} */
let routineEditorOpener = null
/** @type {Array<Record<string, any>>} */
let routineModels = []

async function loadRoutineModels() {
  const response = await sendMessage({ type: MSG.MODELS_LIST })
  routineModels = response?.ok && Array.isArray(response.models)
    ? response.models.filter((model) => model?.id && model?.supportsVision === true)
    : []
  renderRoutineModelOptions()
}

function renderRoutineModelOptions(selectedId = '') {
  const select = document.getElementById('routine-model-id')
  if (!select) return
  select.replaceChildren()
  const fallback = document.createElement('option')
  fallback.value = ''
  fallback.textContent = t('routine_model_default')
  select.appendChild(fallback)
  for (const model of routineModels) {
    const option = document.createElement('option')
    option.value = model.id
    option.textContent = model.displayName || model.name || model.id
    select.appendChild(option)
  }
  if (selectedId && !routineModels.some((model) => model.id === selectedId)) {
    const unavailable = document.createElement('option')
    unavailable.value = selectedId
    unavailable.textContent = selectedId
    select.appendChild(unavailable)
  }
  select.value = selectedId
}

async function loadRoutines() {
  const [response, runResponse] = await Promise.all([
    sendMessage({ type: MSG.ROUTINE_LIST }),
    sendMessage({ type: MSG.ROUTINE_RUN_LIST }),
  ])
  const error = document.getElementById('routines-error')
  if (!response?.ok) {
    routines = []
    if (error) {
      error.hidden = false
      error.textContent = response?.error === 'auth_required'
        ? t('routine_auth_required')
        : t('routine_load_failed')
    }
  } else {
    routines = Array.isArray(response.routines) ? response.routines : []
    routineRuns = runResponse?.ok && Array.isArray(runResponse.runs)
      ? runResponse.runs
      : []
    if (error) {
      error.hidden = true
      error.textContent = ''
    }
  }
  renderRoutines()
}

function renderRoutines() {
  const list = document.getElementById('routines-list')
  const empty = document.getElementById('routines-empty')
  if (!list || !empty) return
  list.replaceChildren()
  empty.hidden = routines.length > 0

  for (const routine of routines) {
    const card = document.createElement('article')
    card.className = 'routine-card'

    const content = document.createElement('button')
    content.type = 'button'
    content.className = 'routine-card-main'
    content.addEventListener('click', () => openRoutineEditor(routine))

    const title = document.createElement('span')
    title.className = 'routine-card-title'
    title.textContent = routine.name
    const command = document.createElement('code')
    command.className = 'routine-card-command'
    command.textContent = `/${routine.command}`
    const description = document.createElement('span')
    description.className = 'routine-card-description'
    description.textContent = routine.description || routine.instructions
    content.append(title, command, description)
    const relatedRuns = routineRuns.filter((run) => run.routineId === routine.id)
    const latestRun = relatedRuns[0]
    if (latestRun) {
      const status = document.createElement('span')
      status.className = 'routine-card-status'
      const target = latestRun.targetTab?.title || latestRun.targetTab?.url || t('routine_target_tab')
      status.textContent = `${t('routine_last_run')}: ${runStatusLabel(latestRun.status)} · ${target}`
      content.append(status)
    }

    const actions = document.createElement('div')
    actions.className = 'routine-card-actions'
    actions.append(
      routineAction(t('routine_run'), 'run', () => runRoutineFromSettings(routine)),
      routineAction(t('routine_simulate'), 'simulate', () => runRoutineFromSettings(routine, true)),
      routineAction(t('routine_duplicate'), 'duplicate', () => duplicateRoutine(routine)),
      routineAction(t('routine_delete'), 'delete', () => deleteRoutine(routine)),
    )
    if (latestRun && ['running', 'waiting_approval'].includes(latestRun.status)) {
      actions.prepend(
        routineAction(t('routine_pause'), 'pause', () => controlRoutineRun(latestRun, 'pause')),
      )
    }
    if (latestRun?.status === 'queued') {
      actions.prepend(
        routineAction(t('routine_resume'), 'resume', () => controlRoutineRun(latestRun, 'resume')),
      )
    }
    if (latestRun && ['queued', 'running', 'waiting_approval'].includes(latestRun.status)) {
      actions.prepend(
        routineAction(t('routine_cancel_run'), 'cancel-run', () => controlRoutineRun(latestRun, 'cancel')),
      )
    }
    if (latestRun?.recoverySuggestion) {
      actions.prepend(
        routineAction(
          t('routine_update_saved_step'),
          'apply-recovery',
          () => applyRecoverySuggestion(latestRun),
        ),
      )
    }

    card.append(content, actions)
    if (latestRun) card.append(renderRunDetails(latestRun, relatedRuns))
    list.appendChild(card)
  }
}

function renderRunDetails(latestRun, relatedRuns) {
  const details = document.createElement('details')
  details.className = 'routine-run-details'
  const summary = document.createElement('summary')
  summary.textContent = t('routine_timeline')
  details.appendChild(summary)

  const meta = document.createElement('div')
  meta.className = 'routine-run-meta'
  const mode = latestRun.mode === 'simulation' ? ` · ${t('routine_simulation_label')}` : ''
  const duration = Number.isFinite(latestRun.durationMs)
    ? ` · ${formatDuration(latestRun.durationMs)}`
    : ''
  meta.textContent = `${runStatusLabel(latestRun.status)}${mode}${duration}`
  details.appendChild(meta)

  const target = document.createElement('div')
  target.className = 'routine-run-target'
  target.textContent = `${t('routine_target_tab')}: ${latestRun.targetTab?.title || latestRun.targetTab?.url || '—'}`
  details.appendChild(target)

  const timeline = document.createElement('ol')
  timeline.className = 'routine-timeline'
  for (const event of Array.isArray(latestRun.events) ? latestRun.events : []) {
    const item = document.createElement('li')
    item.className = `routine-timeline-event routine-timeline-${event.type || 'unknown'}`
    const title = document.createElement('strong')
    title.textContent = event.type === 'tool'
      ? `${t('routine_event_tool')}: ${event.name || 'unknown'}`
      : t(`routine_event_${event.type}`)
    const detail = document.createElement('span')
    detail.textContent = event.type === 'tool'
      ? `${event.success ? '✓' : '✕'}${event.durationMs ? ` · ${formatDuration(event.durationMs)}` : ''}${event.error ? ` · ${event.error}` : ''}`
      : `${formatEventTime(event.at)}${event.error ? ` · ${event.error}` : ''}`
    item.append(title, detail)
    if (event.type === 'simulation' && Array.isArray(event.steps)) {
      const steps = document.createElement('div')
      steps.className = 'routine-simulation-steps'
      for (const step of event.steps) {
        const row = document.createElement('span')
        row.textContent = `${step.index}. ${step.name}`
        steps.appendChild(row)
      }
      item.appendChild(steps)
    }
    timeline.appendChild(item)
  }
  if (timeline.children.length === 0) {
    const empty = document.createElement('li')
    empty.textContent = t('routine_no_previous_run')
    timeline.appendChild(empty)
  }
  details.appendChild(timeline)

  const previous = relatedRuns.find((run) => run.id !== latestRun.id)
  if (previous) {
    const compare = document.createElement('div')
    compare.className = 'routine-run-compare'
    compare.textContent = `${t('routine_compare')}: ${runStatusLabel(previous.status)} → ${runStatusLabel(latestRun.status)}`
    details.appendChild(compare)
  }
  return details
}

function formatDuration(value) {
  const ms = Math.max(0, Number(value) || 0)
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatEventTime(value) {
  const date = new Date(Number(value))
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function runStatusLabel(status) {
  return t(`routine_status_${status}`)
}

async function applyRecoverySuggestion(run) {
  const response = await sendMessage({
    type: MSG.ROUTINE_RECOVERY_APPLY,
    runId: run.id,
  })
  if (!response?.ok) {
    showRoutinesError(response?.error ?? t('routine_recovery_apply_failed'))
    return
  }
  await loadRoutines()
}

function routineAction(label, action, handler) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'routine-card-action'
  button.dataset.action = action
  button.textContent = label
  button.addEventListener('click', () => void handler())
  return button
}

function openRoutineEditor(routine = null) {
  const dialog = document.getElementById('routine-editor-dialog')
  const form = document.getElementById('routine-form')
  if (!dialog || !form) return
  form.reset()
  setRoutineFormError('')
  editorRoutine = routine
  routineEditorOpener = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null

  document.getElementById('routine-id').value = routine?.id ?? ''
  document.getElementById('routine-revision').value = routine?.revision ?? ''
  document.getElementById('routine-name').value = routine?.name ?? ''
  document.getElementById('routine-command').value = routine?.command ?? ''
  document.getElementById('routine-description').value = routine?.description ?? ''
  document.getElementById('routine-instructions').value = routine?.instructions ?? ''
  document.getElementById('routine-start-url').value = routine?.startUrl ?? ''
  document.getElementById('routine-allowed-origins').value =
    Array.isArray(routine?.allowedOrigins) ? routine.allowedOrigins.join('\n') : ''
  renderRoutineModelOptions(routine?.modelId ?? '')
  document.getElementById('routine-cleanup-tabs').checked =
    routine?.cleanupCreatedTabs !== false
  document.getElementById('routine-recorded-steps').value =
    Array.isArray(routine?.recordedSteps) && routine.recordedSteps.length > 0
      ? JSON.stringify(routine.recordedSteps, null, 2)
      : ''
  document.getElementById('routine-branch-selector').value = routine?.branch?.selector ?? ''
  document.getElementById('routine-branch-contains').value = routine?.branch?.contains ?? ''
  document.getElementById('routine-branch-then').value = routine?.branch?.thenInstructions ?? ''
  document.getElementById('routine-branch-else').value = routine?.branch?.elseInstructions ?? ''
  document.getElementById('routine-output-format').value = routine?.output?.format ?? ''
  document.getElementById('routine-output-selector').value = routine?.output?.selector ?? ''
  document.getElementById('routine-subroutines').value =
    Array.isArray(routine?.subroutineCommands) ? routine.subroutineCommands.join('\n') : ''
  document.getElementById('routine-schedule-enabled').checked =
    routine?.schedule?.enabled === true
  document.getElementById('routine-schedule-frequency').value =
    routine?.schedule?.frequency ?? 'daily'
  document.getElementById('routine-schedule-time').value =
    routine?.schedule?.time ?? '09:00'
  document.getElementById('routine-schedule-weekday').value =
    String(routine?.schedule?.weekday ?? 1)
  document.getElementById('routine-schedule-month').value =
    String(routine?.schedule?.month ?? 1)
  document.getElementById('routine-schedule-day').value =
    String(routine?.schedule?.day ?? 1)
  updateScheduleFields()
  renderRoutineFiles(routine?.assets ?? [])

  document.getElementById('routine-editor-title').textContent =
    routine ? t('routine_edit') : t('routine_create')
  dialog.showModal()
  document.getElementById('routine-name')?.focus()
}

function closeRoutineEditor() {
  document.getElementById('routine-editor-dialog')?.close()
}

function routineDraftFromForm() {
  const scheduleEnabled = document.getElementById('routine-schedule-enabled').checked
  const recordedText = document.getElementById('routine-recorded-steps').value.trim()
  let recordedSteps = []
  if (recordedText) {
    try {
      recordedSteps = JSON.parse(recordedText)
    } catch {
      throw new Error('routine_recorded_steps_invalid')
    }
  }
  const allowedOrigins = document.getElementById('routine-allowed-origins').value
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)

  const branchSelector = document.getElementById('routine-branch-selector').value.trim()
  const branchContains = document.getElementById('routine-branch-contains').value.trim()
  const branchThen = document.getElementById('routine-branch-then').value.trim()
  const branchElse = document.getElementById('routine-branch-else').value.trim()
  const branch = branchSelector || branchContains || branchThen || branchElse
    ? { selector: branchSelector, contains: branchContains, thenInstructions: branchThen, elseInstructions: branchElse }
    : null
  const outputFormat = document.getElementById('routine-output-format').value
  const outputSelector = document.getElementById('routine-output-selector').value.trim()
  const output = outputFormat ? { format: outputFormat, ...(outputSelector ? { selector: outputSelector } : {}) } : null
  const subroutineCommands = document.getElementById('routine-subroutines').value
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)

  const frequency = document.getElementById('routine-schedule-frequency').value
  const schedule = scheduleEnabled
    ? {
        enabled: true,
        frequency,
        time: document.getElementById('routine-schedule-time').value,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        ...(frequency === 'weekly'
          ? { weekday: Number(document.getElementById('routine-schedule-weekday').value) }
          : {}),
        ...(frequency === 'monthly' || frequency === 'annual'
          ? { day: Number(document.getElementById('routine-schedule-day').value) }
          : {}),
        ...(frequency === 'annual'
          ? { month: Number(document.getElementById('routine-schedule-month').value) }
          : {}),
      }
    : null

  return {
    name: document.getElementById('routine-name').value,
    command: document.getElementById('routine-command').value,
    description: document.getElementById('routine-description').value,
    instructions: document.getElementById('routine-instructions').value,
    startUrl: document.getElementById('routine-start-url').value,
    allowedOrigins,
    modelId: document.getElementById('routine-model-id').value,
    cleanupCreatedTabs: document.getElementById('routine-cleanup-tabs').checked,
    recordedSteps,
    branch,
    output,
    subroutineCommands,
    schedule,
  }
}

function updateScheduleFields() {
  const enabled = document.getElementById('routine-schedule-enabled')?.checked === true
  const frequency = document.getElementById('routine-schedule-frequency')?.value
  const fields = document.querySelector('.routine-schedule-fields')
  if (fields) fields.hidden = !enabled
  const weekday = document.getElementById('routine-schedule-weekday-field')
  const day = document.getElementById('routine-schedule-day-field')
  const month = document.getElementById('routine-schedule-month-field')
  if (weekday) weekday.hidden = frequency !== 'weekly'
  if (day) day.hidden = frequency !== 'monthly' && frequency !== 'annual'
  if (month) month.hidden = frequency !== 'annual'
  updateScheduleValidity()
}

function updateScheduleValidity() {
  const enabled = document.getElementById('routine-schedule-enabled')?.checked === true
  let valid = true
  if (enabled) {
    const startUrl = document.getElementById('routine-start-url')?.value.trim()
    const origins = document.getElementById('routine-allowed-origins')?.value
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean) ?? []
    const time = document.getElementById('routine-schedule-time')?.value
    try {
      const target = new URL(startUrl)
      valid =
        ['http:', 'https:'].includes(target.protocol) &&
        origins.some((origin) => new URL(origin).origin === target.origin) &&
        /^\d{2}:\d{2}$/.test(time)
    } catch {
      valid = false
    }
  }
  const error = document.getElementById('routine-schedule-error')
  const save = document.getElementById('routine-save')
  if (error) error.hidden = valid
  if (save) save.disabled = !valid
  return valid
}

async function saveRoutine(event) {
  event.preventDefault()
  const id = document.getElementById('routine-id').value
  const revision = Number(document.getElementById('routine-revision').value)
  let draft
  try {
    draft = routineDraftFromForm()
  } catch (error) {
    setRoutineFormError(error?.message ?? String(error))
    return
  }

  const response = id
    ? await sendMessage({
        type: MSG.ROUTINE_UPDATE,
        id,
        expectedRevision: revision,
        patch: draft,
      })
    : await sendMessage({ type: MSG.ROUTINE_CREATE, draft })

  if (!response?.ok) {
    setRoutineFormError(response?.error ?? t('routine_save_failed'))
    return
  }
  let savedRoutine = response.routine
  try {
    savedRoutine = await uploadSelectedRoutineFiles(savedRoutine)
  } catch (error) {
    editorRoutine = savedRoutine
    renderRoutineFiles(savedRoutine?.assets ?? [])
    setRoutineFormError(error?.message ?? String(error))
    await loadRoutines()
    return
  }
  closeRoutineEditor()
  await loadRoutines()
}

async function uploadSelectedRoutineFiles(routine) {
  const input = document.getElementById('routine-files')
  const files = Array.from(input?.files ?? [])
  let current = routine
  for (const file of files) {
    const response = await sendMessage({
      type: MSG.ROUTINE_ASSET_ADD,
      routineId: current.id,
      asset: {
        name: file.name,
        type: file.type,
        dataBase64: await fileToBase64(file),
      },
    })
    if (!response?.ok) throw new Error(response?.error ?? 'routine_asset_upload_failed')
    current = response.routine
  }
  if (input) input.value = ''
  return current
}

function renderRoutineFiles(assets) {
  const list = document.getElementById('routine-files-list')
  if (!list) return
  list.replaceChildren()
  for (const asset of Array.isArray(assets) ? assets : []) {
    const row = document.createElement('div')
    row.className = 'routine-file'
    const name = document.createElement('span')
    name.textContent = asset.name
    const size = document.createElement('span')
    size.className = 'routine-file-size'
    size.textContent = formatBytes(asset.size)
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'routine-file-remove'
    remove.textContent = '×'
    remove.setAttribute('aria-label', t('routine_file_remove'))
    remove.addEventListener('click', () => void removeRoutineFile(asset.id))
    row.append(name, size, remove)
    list.appendChild(row)
  }
}

async function removeRoutineFile(assetId) {
  if (!editorRoutine?.id) return
  const response = await sendMessage({
    type: MSG.ROUTINE_ASSET_DELETE,
    assetId,
  })
  if (!response?.ok) {
    setRoutineFormError(response?.error ?? t('routine_file_remove_failed'))
    return
  }
  editorRoutine = response.routine
  document.getElementById('routine-revision').value = editorRoutine.revision
  renderRoutineFiles(editorRoutine.assets ?? [])
  await loadRoutines()
}

async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunkSize = 32_768
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}

function formatBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes)) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

async function duplicateRoutine(routine) {
  const response = await sendMessage({
    type: MSG.ROUTINE_DUPLICATE,
    id: routine.id,
  })
  if (!response?.ok) {
    showRoutinesError(response?.error ?? t('routine_duplicate_failed'))
    return
  }
  await loadRoutines()
}

async function deleteRoutine(routine) {
  if (!window.confirm(t('routine_delete_confirm'))) return
  const response = await sendMessage({
    type: MSG.ROUTINE_DELETE,
    id: routine.id,
  })
  if (!response?.ok) {
    showRoutinesError(response?.error ?? t('routine_delete_failed'))
    return
  }
  await loadRoutines()
}

async function runRoutineFromSettings(routine, simulate = false) {
  const missing = (routine.variables ?? []).filter(
    (variable) => variable.required !== false && !variable.defaultValue,
  )
  if (missing.length > 0) {
    showRoutinesError(t('routine_variables_open_panel'))
    return
  }
  const variables = Object.fromEntries(
    (routine.variables ?? []).map((variable) => [variable.name, variable.defaultValue ?? '']),
  )
  const response = await sendMessage({
    type: simulate ? MSG.ROUTINE_SIMULATE : MSG.ROUTINE_RUN,
    routineId: routine.id,
    expectedRevision: routine.revision,
    variables,
  })
  if (!response?.ok) showRoutinesError(response?.error ?? t('routine_run_failed'))
}

async function controlRoutineRun(run, action) {
  const type = action === 'pause'
    ? MSG.ROUTINE_PAUSE
    : action === 'resume'
      ? MSG.ROUTINE_RESUME
      : MSG.ROUTINE_CANCEL
  const response = await sendMessage({ type, runId: run.id })
  if (!response?.ok) showRoutinesError(response?.error ?? t('routine_run_failed'))
  await loadRoutines()
}

function setRoutineFormError(message) {
  const error = document.getElementById('routine-form-error')
  if (!error) return
  error.hidden = !message
  error.textContent = message
}

function showRoutinesError(message) {
  const error = document.getElementById('routines-error')
  if (!error) return
  error.hidden = false
  error.textContent = message
}

function initRoutines() {
  document.getElementById('routine-create')?.addEventListener('click', () => {
    openRoutineEditor()
  })
  document.getElementById('routine-form')?.addEventListener('submit', (event) => {
    void saveRoutine(event)
  })
  for (const id of ['routine-editor-close', 'routine-editor-cancel']) {
    document.getElementById(id)?.addEventListener('click', closeRoutineEditor)
  }
  document.getElementById('routine-editor-dialog')?.addEventListener('close', () => {
    editorRoutine = null
    routineEditorOpener?.focus()
    routineEditorOpener = null
  })
  document.getElementById('routine-schedule-enabled')?.addEventListener(
    'change',
    updateScheduleFields,
  )
  document.getElementById('routine-schedule-frequency')?.addEventListener(
    'change',
    updateScheduleFields,
  )
  for (const id of [
    'routine-start-url',
    'routine-allowed-origins',
    'routine-schedule-time',
    'routine-schedule-weekday',
    'routine-schedule-month',
    'routine-schedule-day',
  ]) {
    document.getElementById(id)?.addEventListener('input', updateScheduleValidity)
  }
  chrome.runtime.onMessage.addListener((message) => {
    if (
      message?.type === MSG.ROUTINE_STATE_CHANGED ||
      message?.type === MSG.ROUTINE_RUN_CHANGED
    ) {
      void loadRoutines()
    }
  })
}

async function openTemporaryDraftFromHash() {
  const query = location.hash.includes('?') ? location.hash.split('?')[1] : ''
  const draftId = new URLSearchParams(query).get('draft')
  if (!draftId) return
  const response = await sendMessage({
    type: MSG.ROUTINE_DRAFT_GET,
    draftId,
  })
  if (!response?.ok) {
    showRoutinesError(response?.error ?? t('routine_draft_failed'))
    return
  }
  openRoutineEditor(response.draft)
}

// ── Privacy ─────────────────────────────────────────────────────

function openPrivacy() {
  void chrome.tabs.create({ url: chrome.runtime.getURL('privacy.html') })
}

// ── Init ────────────────────────────────────────────────────────

function resolveBrandAssets() {
  const mascot = chrome.runtime.getURL('icons/verboo-mascot.png')
  const img = document.getElementById('options-mascot')
  if (img) img.src = mascot
}

async function init() {
  applyI18n(document)
  resolveBrandAssets()

  const session = await loadOptionsSession({
    requestAuthState: () => sendMessage({ type: MSG.AUTH_STATE_REQUEST }),
    loadStoredSession: loadSession,
  })
  await renderAuth(session)

  await initModes()
  await renderGrants()
  initRoutines()
  await loadRoutineModels()
  await loadRoutines()
  await openTemporaryDraftFromHash()

  document.getElementById('grants-add-btn')?.addEventListener('click', () => {
    void handleAddGrant()
  })
  document.getElementById('grants-host-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void handleAddGrant()
    }
  })

  document.getElementById('auth-action')?.addEventListener('click', () => {
    void handleLogout()
  })
  document.getElementById('privacy-link')?.addEventListener('click', openPrivacy)

  if (location.hash.startsWith('#routines')) {
    document.getElementById('routines-section')?.scrollIntoView({ block: 'start' })
  }

  // Re-render grants if any other pane mutated them.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    if ('siteGrants' in changes) {
      void renderGrants()
    }
    if ('verbooSession' in changes) {
      void renderAuth(changes.verbooSession.newValue ?? null)
    }
  })
}

init().catch((err) => {
  console.error('[Verboo options] init failed', err)
})
