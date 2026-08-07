const WEEKDAY_BY_NAME = Object.freeze({
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
})

/**
 * Calculate the first scheduled instant strictly after `afterEpochMs`.
 *
 * Recurrence fields are interpreted in the routine's IANA timezone, so a
 * 09:00 routine remains at 09:00 across daylight-saving changes.
 *
 * @param {Record<string, unknown>} schedule
 * @param {number} afterEpochMs
 * @returns {number}
 */
export function nextOccurrence(schedule, afterEpochMs) {
  const timezone = validateTimezone(schedule?.timezone)
  const { hour, minute } = parseTime(schedule?.time)
  const after = Number(afterEpochMs)
  if (!Number.isFinite(after)) throw new Error('schedule_after_invalid')

  const local = zonedParts(after, timezone)
  let candidate

  switch (schedule?.frequency) {
    case 'daily':
      candidate = localDate(local.year, local.month, local.day, hour, minute)
      if (toEpoch(candidate, timezone) <= after) candidate = addDays(candidate, 1)
      break
    case 'weekly': {
      const weekday = boundedInteger(schedule?.weekday, 0, 6, 'schedule_weekday_invalid')
      const daysAhead = (weekday - local.weekday + 7) % 7
      candidate = addDays(
        localDate(local.year, local.month, local.day, hour, minute),
        daysAhead,
      )
      if (toEpoch(candidate, timezone) <= after) candidate = addDays(candidate, 7)
      break
    }
    case 'monthly': {
      const day = boundedInteger(schedule?.day, 1, 31, 'schedule_day_invalid')
      candidate = clampedLocalDate(local.year, local.month, day, hour, minute)
      if (toEpoch(candidate, timezone) <= after) {
        const nextMonth = shiftMonth(local.year, local.month, 1)
        candidate = clampedLocalDate(
          nextMonth.year,
          nextMonth.month,
          day,
          hour,
          minute,
        )
      }
      break
    }
    case 'annual': {
      const month = boundedInteger(schedule?.month, 1, 12, 'schedule_month_invalid')
      const day = boundedInteger(schedule?.day, 1, 31, 'schedule_day_invalid')
      candidate = clampedLocalDate(local.year, month, day, hour, minute)
      if (toEpoch(candidate, timezone) <= after) {
        candidate = clampedLocalDate(local.year + 1, month, day, hour, minute)
      }
      break
    }
    default:
      throw new Error('schedule_frequency_invalid')
  }

  return toEpoch(candidate, timezone)
}

/**
 * Stable idempotency key for one scheduled occurrence.
 *
 * @param {string} routineId
 * @param {number} scheduledAt
 * @returns {string}
 */
export function occurrenceKey(routineId, scheduledAt) {
  return `${routineId}:${Number(scheduledAt)}`
}

function validateTimezone(value) {
  const timezone = String(value ?? '').trim()
  if (!timezone) throw new Error('schedule_timezone_invalid')
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0)
    return timezone
  } catch {
    throw new Error('schedule_timezone_invalid')
  }
}

function parseTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? ''))
  if (!match) throw new Error('schedule_time_invalid')
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) throw new Error('schedule_time_invalid')
  return { hour, minute }
}

function boundedInteger(value, min, max, error) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(error)
  }
  return number
}

function zonedParts(epochMs, timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  })
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(epochMs))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  )
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_BY_NAME[parts.weekday],
  }
}

function localDate(year, month, day, hour, minute) {
  return { year, month, day, hour, minute }
}

function clampedLocalDate(year, month, day, hour, minute) {
  return localDate(year, month, Math.min(day, daysInMonth(year, month)), hour, minute)
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function shiftMonth(year, month, amount) {
  const shifted = new Date(Date.UTC(year, month - 1 + amount, 1))
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
  }
}

function addDays(parts, amount) {
  const shifted = new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day + amount,
    parts.hour,
    parts.minute,
  ))
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  }
}

function toEpoch(target, timezone) {
  const targetAsUtc = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
  )
  let guess = targetAsUtc

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const actual = zonedParts(guess, timezone)
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
    )
    const delta = targetAsUtc - actualAsUtc
    if (delta === 0) return guess
    guess += delta
  }

  return guess
}
