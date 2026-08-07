/**
 * Small, pure presentation helpers shared by the side-panel UI and tests.
 * Model labels stay catalog-driven; no provider or model IDs are hardcoded.
 */

/**
 * @param {{ id?: string, name?: string, displayName?: string }} model
 * @returns {string}
 */
export function modelDisplayName(model) {
  const id = String(model?.id ?? '').trim()
  const supplied = String(model?.displayName || model?.name || '').trim()
  if (supplied && supplied !== id) return supplied
  return humanizeModelId(id) || supplied || 'Model'
}

/** @param {string} id */
export function humanizeModelId(id) {
  return String(id ?? '')
    .trim()
    .split(/[\s/_-]+/)
    .filter(Boolean)
    .map((token) => {
      if (/^[a-z]{1,3}$/i.test(token)) return token.toUpperCase()
      if (/^[a-z]\d/i.test(token)) return token.toUpperCase()
      if (/^\d+[a-z]$/i.test(token)) return token.toUpperCase()
      const match = token.match(/^([a-z]+)(\d.*)$/i)
      if (match) return `${capitalize(match[1])} ${match[2].toUpperCase()}`
      return capitalize(token)
    })
    .join(' ')
}

/**
 * Render the deliberately small Markdown subset used in assistant summaries.
 * Input is escaped first, so assigning the result to innerHTML cannot execute
 * model-provided markup. Supported: headings, bold, inline/fenced code, lists, and
 * line breaks.
 * @param {unknown} value
 * @returns {string}
 */
export function safeMarkdownToHtml(value) {
  const lines = escapeHtml(String(value ?? '')).split(/\r?\n/)
  const rendered = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fence = line.match(/^```[A-Za-z0-9_-]*\s*$/)
    if (fence) {
      const codeLines = []
      while (index + 1 < lines.length && !/^```\s*$/.test(lines[index + 1])) {
        index += 1
        codeLines.push(lines[index])
      }
      if (index + 1 < lines.length) index += 1
      rendered.push(`<pre><code>${codeLines.join('\n')}</code></pre>`)
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      rendered.push(`<h${heading[1].length}>${formatInlineMarkdown(heading[2])}</h${heading[1].length}>`)
      continue
    }

    const unordered = line.match(/^[-*]\s+(.+)$/)
    if (unordered) {
      const items = [unordered[1]]
      while (index + 1 < lines.length) {
        const next = lines[index + 1].match(/^[-*]\s+(.+)$/)
        if (!next) break
        items.push(next[1])
        index += 1
      }
      rendered.push(`<ul>${items.map((item) => `<li>${formatInlineMarkdown(item)}</li>`).join('')}</ul>`)
      continue
    }

    const ordered = line.match(/^\d+[.)]\s+(.+)$/)
    if (ordered) {
      const items = [ordered[1]]
      while (index + 1 < lines.length) {
        const next = lines[index + 1].match(/^\d+[.)]\s+(.+)$/)
        if (!next) break
        items.push(next[1])
        index += 1
      }
      rendered.push(`<ol>${items.map((item) => `<li>${formatInlineMarkdown(item)}</li>`).join('')}</ol>`)
      continue
    }

    rendered.push(formatInlineMarkdown(line))
  }

  return rendered.join('<br>')
}

/**
 * Build a bounded, useful preview for structured browser-tool results.
 * @param {unknown} value
 * @returns {string}
 */
export function structuredResultPreview(value) {
  if (!value || typeof value !== 'object' || !('data' in value)) return ''
  const record = /** @type {Record<string, unknown>} */ (value)
  const format = typeof record.format === 'string' ? record.format.toUpperCase() : ''
  let preview = ''
  if (typeof record.data === 'string') {
    preview = record.data.replace(/\s+/g, ' ').trim()
  } else if (record.data != null) {
    try {
      preview = JSON.stringify(record.data)
    } catch {
      preview = ''
    }
  }
  if (!preview) return format
  const clipped = preview.length > 120 ? `${preview.slice(0, 117)}…` : preview
  return format ? `${format} · ${clipped}` : clipped
}

/** @param {string} value */
function formatInlineMarkdown(value) {
  return value
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
}

/**
 * Translate a backend error code without leaking unknown internal codes.
 * @param {unknown} errorCode
 * @param {string} fallbackKey
 * @param {(key: string) => string} translate
 * @returns {string}
 */
export function translatedErrorMessage(errorCode, fallbackKey, translate) {
  const code = String(errorCode ?? '').trim()
  if (!code) return translate(fallbackKey)
  const translated = translate(code)
  return translated && translated !== code ? translated : translate(fallbackKey)
}

/**
 * Avoid stacking the same error twice when the user repeats an action.
 * @param {unknown} previousError
 * @param {unknown} nextError
 * @returns {boolean}
 */
export function shouldAppendError(previousError, nextError) {
  const previous = String(previousError ?? '')
  const next = String(nextError ?? '')
  return !previous || previous !== next
}

/**
 * Submit only for an unmodified Enter that was not already handled by
 * another interaction, such as the slash menu or an IME composition.
 * @param {{key?: string, shiftKey?: boolean, isComposing?: boolean, defaultPrevented?: boolean}} event
 * @returns {boolean}
 */
export function shouldSubmitComposerKey(event) {
  return event?.key === 'Enter'
    && !event.shiftKey
    && !event.isComposing
    && !event.defaultPrevented
}

/** @param {unknown} value */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function capitalize(value) {
  const text = String(value ?? '')
  return text ? text[0].toUpperCase() + text.slice(1) : ''
}
