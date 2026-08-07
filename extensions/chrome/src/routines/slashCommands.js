import { normalizeCommand } from './schema.js'

const MAX_RESULTS = 8

/**
 * Parse a complete slash command without accepting commands embedded in prose.
 *
 * @param {unknown} input
 * @returns {{command: string}|null}
 */
export function parseSlashInvocation(input) {
  const match = String(input ?? '').trim().match(/^\/([^\s/]+)$/)
  if (!match) return null
  const command = normalizeCommand(match[1])
  return command ? { command } : null
}

/**
 * Match slash menu entries while preserving the routine objects owned by state.
 *
 * @param {unknown} input
 * @param {Array<Record<string, unknown>>} routines
 * @returns {Array<Record<string, unknown>>}
 */
export function matchSlashQuery(input, routines) {
  const text = String(input ?? '')
  if (!text.startsWith('/')) return []
  const query = normalizeSearchText(text.slice(1))

  return (Array.isArray(routines) ? routines : [])
    .map((routine, index) => ({
      routine,
      index,
      score: scoreRoutine(routine, query),
    }))
    .filter(({ score }) => score >= 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, MAX_RESULTS)
    .map(({ routine }) => routine)
}

function scoreRoutine(routine, query) {
  if (!routine || typeof routine !== 'object') return -1
  const command = normalizeSearchText(routine.command)
  const name = normalizeSearchText(routine.name)
  const description = normalizeSearchText(routine.description)

  if (!query) return 1
  if (command === query) return 100
  if (command.startsWith(query)) return 80
  if (name.startsWith(query)) return 60
  if (command.includes(query)) return 40
  if (name.includes(query)) return 30
  if (description.includes(query)) return 10
  return -1
}

function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
}
