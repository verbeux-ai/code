const COMMAND_MAX_LENGTH = 64
const VARIABLE_PATTERN = /\{\{([a-zA-Z][\w-]{0,63})\}\}/g
const NAME_MAX_LENGTH = 80
const DESCRIPTION_MAX_LENGTH = 240
const INSTRUCTIONS_MAX_LENGTH = 32_000
const BRANCH_TEXT_MAX_LENGTH = 2_000
const SUBROUTINE_MAX_COUNT = 8
const SUBROUTINE_COMMAND_MAX_LENGTH = 64
const STRUCTURED_SELECTOR_MAX_LENGTH = 256

/**
 * Convert a routine name or slash command into the canonical command slug.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeCommand(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/^\/+/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, COMMAND_MAX_LENGTH)
}

/**
 * Return unique routine placeholders in first-appearance order.
 *
 * @param {unknown} instructions
 * @returns {string[]}
 */
export function extractVariableNames(instructions) {
  const names = []
  for (const match of String(instructions ?? '').matchAll(VARIABLE_PATTERN)) {
    if (!names.includes(match[1])) names.push(match[1])
  }
  return names
}

/**
 * Normalize a user-authored routine at the persistence seam.
 *
 * @param {Record<string, unknown>} input
 * @param {string} accountId
 * @param {{id: string, revision?: number, createdAt?: number, updatedAt: number}} identity
 * @returns {Record<string, unknown>}
 */
export function normalizeRoutineDraft(input, accountId, identity) {
  const owner = String(accountId ?? '').trim()
  if (!owner) throw new Error('routine_account_required')

  const name = String(input?.name ?? '').trim().slice(0, NAME_MAX_LENGTH)
  if (!name) throw new Error('routine_name_required')

  const command = normalizeCommand(input?.command || name)
  if (!command) throw new Error('routine_command_required')

  const instructions = String(input?.instructions ?? '').trim().slice(0, INSTRUCTIONS_MAX_LENGTH)
  if (!instructions) throw new Error('routine_instructions_required')

  const startUrl = normalizeOptionalHttpUrl(input?.startUrl)
  const allowedOrigins = normalizeAllowedOrigins(input?.allowedOrigins, startUrl)
  const variables = normalizeVariables(input?.variables, instructions)
  const recordedSteps = cloneArray(input?.recordedSteps)
  const assets = cloneArray(input?.assets)
  const schedule = normalizeSchedule(input?.schedule)
  const branch = normalizeBranch(input?.branch)
  const subroutineCommands = normalizeSubroutineCommands(input?.subroutineCommands)
  const output = normalizeStructuredOutput(input?.output)

  return {
    schemaVersion: 1,
    id: identity.id,
    accountId: owner,
    revision: identity.revision ?? 1,
    name,
    command,
    description: String(input?.description ?? '').trim().slice(0, DESCRIPTION_MAX_LENGTH),
    instructions,
    ...(startUrl ? { startUrl } : {}),
    allowedOrigins,
    variables,
    assets,
    strategy: recordedSteps.length > 0 ? 'hybrid' : 'semantic',
    recordedSteps,
    ...(branch ? { branch } : {}),
    ...(subroutineCommands.length > 0 ? { subroutineCommands } : {}),
    ...(output ? { output } : {}),
    ...(typeof input?.modelId === 'string' && input.modelId.trim()
      ? { modelId: input.modelId.trim() }
      : {}),
    cleanupCreatedTabs: input?.cleanupCreatedTabs !== false,
    ...(schedule === undefined ? {} : { schedule }),
    createdAt: identity.createdAt ?? identity.updatedAt,
    updatedAt: identity.updatedAt,
  }
}

function normalizeBranch(value) {
  if (!value || typeof value !== 'object') return undefined
  const selector = String(value.selector ?? '').trim().slice(0, STRUCTURED_SELECTOR_MAX_LENGTH)
  const contains = String(value.contains ?? '').trim().slice(0, BRANCH_TEXT_MAX_LENGTH)
  if (!selector || !contains) throw new Error('routine_branch_invalid')
  const thenInstructions = String(value.thenInstructions ?? '').trim().slice(0, BRANCH_TEXT_MAX_LENGTH)
  const elseInstructions = String(value.elseInstructions ?? '').trim().slice(0, BRANCH_TEXT_MAX_LENGTH)
  if (!thenInstructions && !elseInstructions) throw new Error('routine_branch_invalid')
  return { selector, contains, thenInstructions, elseInstructions }
}

function normalizeSubroutineCommands(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .map((command) => normalizeCommand(command).slice(0, SUBROUTINE_COMMAND_MAX_LENGTH))
    .filter(Boolean))].slice(0, SUBROUTINE_MAX_COUNT)
}

function normalizeStructuredOutput(value) {
  if (!value || typeof value !== 'object') return undefined
  const format = String(value.format ?? '').trim().toLowerCase()
  if (!['json', 'csv', 'table'].includes(format)) throw new Error('routine_output_format_invalid')
  const selector = String(value.selector ?? '').trim().slice(0, STRUCTURED_SELECTOR_MAX_LENGTH)
  return { format, ...(selector ? { selector } : {}) }
}

function normalizeOptionalHttpUrl(value) {
  const text = String(value ?? '').trim()
  if (!text) return undefined
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('routine_start_url_invalid')
    }
    return url.toString()
  } catch (error) {
    if (error?.message === 'routine_start_url_invalid') throw error
    throw new Error('routine_start_url_invalid')
  }
}

function normalizeAllowedOrigins(value, startUrl) {
  const candidates = Array.isArray(value) ? [...value] : []
  if (startUrl) candidates.push(new URL(startUrl).origin)
  const origins = []
  for (const candidate of candidates) {
    try {
      const url = new URL(String(candidate))
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('routine_origin_invalid')
      }
      if (!origins.includes(url.origin)) origins.push(url.origin)
    } catch (error) {
      if (error?.message === 'routine_origin_invalid') throw error
      throw new Error('routine_origin_invalid')
    }
  }
  return origins
}

function normalizeVariables(value, instructions) {
  const provided = new Map()
  if (Array.isArray(value)) {
    for (const variable of value) {
      if (!variable || typeof variable !== 'object') continue
      const name = String(variable.name ?? '')
      if (!name) continue
      provided.set(name, variable)
    }
  }
  return extractVariableNames(instructions).map((name) => ({
    name,
    required: provided.get(name)?.required !== false,
    defaultValue: String(provided.get(name)?.defaultValue ?? ''),
  }))
}

function normalizeSchedule(value) {
  if (value == null || value.enabled !== true) return undefined
  const frequency = String(value.frequency ?? '')
  if (!['daily', 'weekly', 'monthly', 'annual'].includes(frequency)) {
    throw new Error('schedule_frequency_invalid')
  }
  const time = String(value.time ?? '')
  const match = /^(\d{2}):(\d{2})$/.exec(time)
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new Error('schedule_time_invalid')
  }
  const timezone = String(value.timezone ?? '').trim()
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0)
  } catch {
    throw new Error('schedule_timezone_invalid')
  }
  const schedule = { enabled: true, frequency, time, timezone }
  if (frequency === 'weekly') {
    schedule.weekday = boundedInteger(
      value.weekday,
      0,
      6,
      'schedule_weekday_invalid',
    )
  }
  if (frequency === 'monthly' || frequency === 'annual') {
    schedule.day = boundedInteger(value.day, 1, 31, 'schedule_day_invalid')
  }
  if (frequency === 'annual') {
    schedule.month = boundedInteger(value.month, 1, 12, 'schedule_month_invalid')
  }
  if (value.nextRunAt != null) {
    const nextRunAt = Number(value.nextRunAt)
    if (!Number.isFinite(nextRunAt)) throw new Error('schedule_next_run_invalid')
    schedule.nextRunAt = nextRunAt
  }
  return schedule
}

function boundedInteger(value, min, max, error) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(error)
  }
  return number
}

function cloneArray(value) {
  return Array.isArray(value) ? cloneValue(value) : []
}

function cloneValue(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value))
}
