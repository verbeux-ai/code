import { safeParseJSON } from './json.js'

/**
 * Reads a JSON object from a model reply that was asked for JSON in the prompt
 * but not through structured output (the Verboo router can reject
 * `output_format` with structured_output_not_enabled). Tolerates inline `<think>` reasoning, code
 * fences and prose around the object. Returns null when no object is found.
 */
export function parseModelJsonObject(text: string): unknown {
  const raw = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  if (!raw) return null

  const whole = safeParseJSON(raw, false)
  if (whole && typeof whole === 'object' && !Array.isArray(whole)) return whole

  // First balanced {...} that parses, skipping braces inside strings.
  for (let start = raw.indexOf('{'); start >= 0; start = raw.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    for (let index = start; index < raw.length; index++) {
      const char = raw[index]
      if (inString) {
        if (char === '\\') index++
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') inString = true
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) {
        const candidate = safeParseJSON(raw.slice(start, index + 1), false)
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate
        break
      }
    }
  }
  return null
}
