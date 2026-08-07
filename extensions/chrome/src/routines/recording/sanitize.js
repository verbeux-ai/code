import { normalizeCommand } from '../schema.js'

const SENSITIVE_PATTERN =
  /(?:pass(?:word)?|passwd|secret|token|api[_-]?key|auth|otp|pin|cvv|cvc|card|credit|debit|ssn|cpf|bank|routing)/i
const SENSITIVE_AUTOCOMPLETE =
  /^(?:current-password|new-password|one-time-code|cc-|transaction-|webauthn)/i

export function isSensitiveField(metadata = {}) {
  if (String(metadata.type ?? '').toLowerCase() === 'password') return true
  if (SENSITIVE_AUTOCOMPLETE.test(String(metadata.autocomplete ?? ''))) return true
  return [
    metadata.name,
    metadata.id,
    metadata.label,
    metadata.placeholder,
    metadata.ariaLabel,
  ].some((value) => SENSITIVE_PATTERN.test(String(value ?? '')))
}

export function sanitizeRecordedEvent(event) {
  if (!event || typeof event !== 'object') return null
  const kind = String(event.kind ?? '')
  if (!['click', 'input', 'change', 'submit'].includes(kind)) return null
  if ((kind === 'input' || kind === 'change') && isSensitiveField(event.field)) {
    return null
  }

  const base = {
    kind,
    url: normalizeHttpUrl(event.url),
    selectorCandidates: normalizeSelectors(event.selectorCandidates),
    ...(event.role ? { role: String(event.role).slice(0, 80) } : {}),
    ...(event.accessibleName
      ? { accessibleName: String(event.accessibleName).slice(0, 180) }
      : {}),
    ...(event.text ? { text: String(event.text).trim().slice(0, 180) } : {}),
    timestamp: Number.isFinite(event.timestamp) ? event.timestamp : Date.now(),
  }
  if (kind !== 'input' && kind !== 'change') return base

  return {
    ...base,
    field: {
      type: String(event.field?.type ?? 'text').slice(0, 40),
      name: String(event.field?.name ?? '').slice(0, 80),
      autocomplete: String(event.field?.autocomplete ?? '').slice(0, 80),
      label: String(event.field?.label ?? '').slice(0, 180),
    },
    valueMode: 'unresolved',
    ephemeralValue: String(event.value ?? '').slice(0, 4_000),
  }
}

export function recordedEventsToDraft(events) {
  const safeEvents = (Array.isArray(events) ? events : [])
    .map((event) => sanitizeRecordedEvent(event))
    .filter(Boolean)
  if (safeEvents.length === 0) throw new Error('routine_recording_empty')

  const variables = []
  const recordedSteps = safeEvents.map((event, index) => {
    const selector = event.selectorCandidates[0] ?? ''
    if (event.kind === 'input' || event.kind === 'change') {
      const variableName = uniqueVariableName(event.field, index, variables)
      variables.push(variableName)
      return {
        name: 'type',
        params: { selector, text: `{{${variableName}}}` },
        semantic: semanticMetadata(event),
      }
    }
    return {
      name: event.kind === 'submit' ? 'click' : event.kind,
      params: { selector },
      semantic: semanticMetadata(event),
    }
  })

  const startUrl = safeEvents[0].url
  const origin = new URL(startUrl).origin
  const variableCopy = variables.length > 0
    ? ` Ask for ${variables.map((name) => `{{${name}}}`).join(', ')} before running.`
    : ''
  return {
    name: 'Recorded workflow',
    command: normalizeCommand(`recorded-${new URL(startUrl).hostname}`),
    description: `Recorded on ${new URL(startUrl).hostname}`,
    instructions: `Replay the recorded browser steps in order.${variableCopy}`,
    startUrl,
    allowedOrigins: [origin],
    variables: variables.map((name) => ({
      name,
      required: true,
      defaultValue: '',
    })),
    recordedSteps,
    cleanupCreatedTabs: true,
  }
}

function semanticMetadata(event) {
  return {
    selectorCandidates: event.selectorCandidates,
    ...(event.role ? { role: event.role } : {}),
    ...(event.accessibleName ? { accessibleName: event.accessibleName } : {}),
    ...(event.text ? { text: event.text } : {}),
    url: event.url,
  }
}

function uniqueVariableName(field, index, existing) {
  const raw = field?.name || field?.label || `input_${index + 1}`
  const base = normalizeCommand(raw).replaceAll('-', '_') || `input_${index + 1}`
  let candidate = /^[a-zA-Z]/.test(base) ? base : `input_${base}`
  let suffix = 2
  while (existing.includes(candidate)) {
    candidate = `${base}_${suffix}`
    suffix += 1
  }
  return candidate.slice(0, 64)
}

function normalizeHttpUrl(value) {
  try {
    const url = new URL(String(value ?? ''))
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
    url.hash = ''
    return url.toString()
  } catch {
    throw new Error('routine_recording_url_invalid')
  }
}

function normalizeSelectors(value) {
  return (Array.isArray(value) ? value : [])
    .filter((selector) => typeof selector === 'string' && selector.trim())
    .map((selector) => selector.trim().slice(0, 500))
    .slice(0, 5)
}
