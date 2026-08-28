export type StreamedToolNameResolution = {
  name: string
  ambiguous: boolean
  recoveredUniquePrefix: boolean
}

// JSON permits escaped lone UTF-16 surrogates even though they are not Unicode
// scalar values. Terminal encoders turn them into U+FFFD, which looks like a
// random corrupted character despite the transport itself being valid UTF-8.
export function hasInvalidUnicodeScalar(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
	  if (index + 1 >= value.length) return true
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      index++
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true
    }
  }
  return false
}

export function hasInvalidUnicodeScalarDeep(value: unknown): boolean {
  const pending: unknown[] = [value]
  const seen = new Set<object>()
  while (pending.length > 0) {
    const current = pending.pop()
    if (typeof current === 'string') {
      if (hasInvalidUnicodeScalar(current)) return true
      continue
    }
    if (!current || typeof current !== 'object' || seen.has(current)) continue
    seen.add(current)
    if (Array.isArray(current)) {
      pending.push(...current)
      continue
    }
    for (const [key, nested] of Object.entries(
      current as Record<string, unknown>,
    )) {
      if (hasInvalidUnicodeScalar(key)) return true
      pending.push(nested)
    }
  }
  return false
}

// OpenAI defines tool names as deltas, but compatible providers sometimes
// emit cumulative snapshots. Resolve both representations and only accept a
// canonical tool when every viable representation agrees.
export function resolveStreamedToolName(
  advertisedToolNames: readonly string[],
  fragments: readonly string[],
  recoverableToolNames: readonly string[] = [],
): StreamedToolNameResolution {
  const nonEmpty = fragments.filter(Boolean)
  const concatenated = nonEmpty.join('')
  if (advertisedToolNames.length === 0) {
    return { name: concatenated, ambiguous: false, recoveredUniquePrefix: false }
  }

  const candidates = new Set<string>([concatenated])
  let cumulative = ''
  for (const fragment of nonEmpty) {
    if (!cumulative) {
      cumulative = fragment
      continue
    }
    const currentFolded = cumulative.toLowerCase()
    const fragmentFolded = fragment.toLowerCase()
    if (fragmentFolded.startsWith(currentFolded)) {
      cumulative = fragment
    } else if (!currentFolded.startsWith(fragmentFolded)) {
      cumulative += fragment
    }
  }
  candidates.add(cumulative)

  const resolved = new Set<string>()
  for (const candidate of candidates) {
    const toolName = resolveToolNameByUniquePrefix(
      advertisedToolNames,
      candidate,
      recoverableToolNames,
    )
    if (toolName) resolved.add(toolName)
  }
  if (resolved.size === 1) {
    const name = [...resolved][0]!
    const hasExactReconstruction = [...candidates].some(
      candidate => candidate.toLowerCase() === name.toLowerCase(),
    )
    return {
      name,
      ambiguous: false,
      recoveredUniquePrefix: !hasExactReconstruction,
    }
  }
  return { name: concatenated, ambiguous: true, recoveredUniquePrefix: false }
}

export function runOpenAIProtocolReliabilitySelfTest(): {
  ok: boolean
  detail: string
} {
  const marker = 'Verboo: ação, ç, 你好, 👩🏽‍💻, e\u0301'
  const encoded = new TextEncoder().encode(marker)
  for (let split = 1; split < encoded.length; split++) {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const decoded =
      decoder.decode(encoded.slice(0, split), { stream: true }) +
      decoder.decode(encoded.slice(split))
    if (decoded !== marker) {
      return { ok: false, detail: `Unicode stream split failed at byte ${split}.` }
    }
  }

  let rejectedInvalidUTF8 = false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(
      new Uint8Array([0xc3, 0x28]),
    )
  } catch {
    rejectedInvalidUTF8 = true
  }
  if (!rejectedInvalidUTF8) {
    return { ok: false, detail: 'Invalid UTF-8 was accepted.' }
  }

  if (
    !hasInvalidUnicodeScalar(String.fromCharCode(0xd800)) ||
    hasInvalidUnicodeScalar('ação 👩🏽‍💻') ||
    !hasInvalidUnicodeScalarDeep({ nested: String.fromCharCode(0xdc00) }) ||
    hasInvalidUnicodeScalarDeep({ nested: '你好 👩🏽‍💻' })
  ) {
    return { ok: false, detail: 'Unicode scalar validation failed.' }
  }

  const exact = resolveStreamedToolName(['read'], ['rea', 'd'], ['read'])
  if (exact.name !== 'read' || exact.ambiguous || exact.recoveredUniquePrefix) {
    return { ok: false, detail: 'Exact rea+d tool reconstruction failed.' }
  }
  const truncated = resolveStreamedToolName(['read'], ['rea'], ['read'])
  if (
    truncated.name !== 'read' ||
    truncated.ambiguous ||
    !truncated.recoveredUniquePrefix
  ) {
    return { ok: false, detail: 'Terminal tool prefix classification failed.' }
  }

  return {
    ok: true,
    detail: 'Strict UTF-8 and exact/terminal-prefix tool checks passed.',
  }
}
import { resolveToolNameByUniquePrefix } from '../../Tool.js'
