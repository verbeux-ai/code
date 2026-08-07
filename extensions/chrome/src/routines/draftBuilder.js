import { extractVariableNames, normalizeCommand } from './schema.js'

const APPROVED_MODEL_FIELDS = new Set([
  'name',
  'command',
  'description',
  'instructions',
  'startUrl',
  'allowedOrigins',
  'modelId',
  'cleanupCreatedTabs',
])

export function buildPromptDraft(text, page = {}) {
  const instructions = String(text ?? '').trim()
  if (!instructions) throw new Error('routine_instructions_required')
  const words = instructions.replace(/\{\{|\}\}/g, '').split(/\s+/).slice(0, 7)
  const name = words.join(' ').replace(/[.!?,;:]+$/g, '').slice(0, 80) || 'Routine'
  const startUrl = normalizePageUrl(page?.url)
  const variables = extractVariableNames(instructions).map((variableName) => ({
    name: variableName,
    required: true,
    defaultValue: '',
  }))

  return {
    name,
    command: normalizeCommand(instructions),
    description: '',
    instructions,
    ...(startUrl ? { startUrl, allowedOrigins: [new URL(startUrl).origin] } : {
      allowedOrigins: [],
    }),
    variables,
    cleanupCreatedTabs: true,
  }
}

export function buildConversationDraft(history, modelDraft) {
  const userMessages = (Array.isArray(history) ? history : [])
    .filter((message) => message?.role === 'user' && typeof message.content === 'string')
    .map((message) => message.content.trim())
    .filter(Boolean)

  const parsed = parseModelDraft(modelDraft)
  if (!parsed) return buildPromptDraft(userMessages.join('\n\n'))

  const approved = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (APPROVED_MODEL_FIELDS.has(key)) approved[key] = value
  }
  const fallback = buildPromptDraft(userMessages.join('\n\n') || approved.instructions)
  const instructions = String(approved.instructions ?? fallback.instructions).trim()
  if (!instructions) return fallback
  return {
    ...fallback,
    ...approved,
    command: normalizeCommand(approved.command || approved.name || fallback.command),
    instructions,
    allowedOrigins: normalizeOrigins(approved.allowedOrigins ?? fallback.allowedOrigins),
    variables: extractVariableNames(instructions).map((name) => ({
      name,
      required: true,
      defaultValue: '',
    })),
  }
}

function parseModelDraft(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (!String(parsed.name ?? '').trim() || !String(parsed.instructions ?? '').trim()) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function normalizePageUrl(value) {
  try {
    const url = new URL(String(value ?? ''))
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function normalizeOrigins(value) {
  const origins = []
  for (const candidate of Array.isArray(value) ? value : []) {
    try {
      const url = new URL(String(candidate))
      if (!['http:', 'https:'].includes(url.protocol)) continue
      if (!origins.includes(url.origin)) origins.push(url.origin)
    } catch {
      // Model output is advisory; invalid origins are dropped.
    }
  }
  return origins
}
