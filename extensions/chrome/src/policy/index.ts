/**
 * policy/index.ts — Unified policy facade.
 *
 * Composes two internal modules:
 *   - hardBlocks.js (ANVIL): intent-based regex (purchase, trade, secret_exposure)
 *   - policy.js (NEXUS): URL-based regex (chrome://, .gov.br, sensitive paths)
 *
 * Public API:
 *   - checkIntent(input)         → intent-only verdict
 *   - checkUrl(url, config?)    → URL-only verdict
 *   - checkPolicy({input, url, mode, grants}) → composed verdict
 *
 * Multi-user: zero hardcoded path/user/token.
 */

import { checkHardBlock } from './hardBlocks.js'
import { checkUrl as checkUrlInternal } from './policy.js'

export type PolicyMode = 'manual' | 'auto' | 'skip'

export interface PolicyInput {
  /** Tool name + params as a single string (e.g. "tool:click text=Buy now"). */
  input: string
  /** Target URL of the active tab. */
  url: string
  /** Chrome permission mode. */
  mode: PolicyMode
  /** Per-host grants (host → decision). */
  grants?: Array<{ host: string; decision: 'once' | 'always' | 'deny' }>
}

export type PolicyVerdict = 'allow' | 'deny' | 'confirm'

export interface PolicyDecision {
  verdict: PolicyVerdict
  /** Why this verdict was reached. */
  reason: string
  /** Which rule matched, if any. */
  matchedLabel?: string
}

// ── Public API ─────────────────────────────────────────────

/** Check intent only (tool description against hard blocks). */
export function checkIntent(input: string): PolicyDecision {
  const r = checkHardBlock(input)
  if (r.blocked) {
    return { verdict: 'deny', reason: 'hard_block', matchedLabel: r.matchedLabel }
  }
  return { verdict: 'allow', reason: 'no_intent_match' }
}

/** Check URL only (against hard URL blocks + sensitive categories). */
export function checkUrl(
  url: string,
  config?: { allowlist?: unknown[]; blocklist?: unknown[] }
): PolicyDecision {
  const r = checkUrlInternal(url, config as never)
  if (r.verdict === 'deny') {
    return { verdict: 'deny', reason: r.matchedRule?.reason ?? 'url_block', matchedLabel: r.matchedRule?.reason }
  }
  if (r.verdict === 'confirm') {
    return { verdict: 'confirm', reason: `sensitive:${r.category}` }
  }
  return { verdict: 'allow', reason: 'general_url' }
}

/**
 * Composed policy check: intent + URL + mode + grants.
 *
 * Order:
 *   1. Intent hard block → deny (never bypassable)
 *   2. URL hard block → deny (never bypassable)
 *   3. URL sensitive → confirm (unless grant says otherwise)
 *   4. Grant deny → deny
 *   5. Grant always → allow
 *   6. Mode 'skip' → allow
 *   7. Mode 'auto' → allow (with safety already checked)
 *   8. Mode 'manual' → confirm
 */
export function checkPolicy(input: PolicyInput): PolicyDecision {
  // 1. Intent hard block
  const intent = checkIntent(input.input)
  if (intent.verdict === 'deny') return intent

  // 2. URL hard block
  const url = checkUrl(input.url)
  if (url.verdict === 'deny' && url.reason !== 'sensitive') return url

  // 3. URL sensitive — check grants
  if (url.verdict === 'confirm') {
    const host = extractHost(input.url)
    const grant = input.grants?.find((g) => g.host === host)
    if (grant?.decision === 'deny') return { verdict: 'deny', reason: 'grant_deny' }
    if (grant?.decision === 'always') return { verdict: 'allow', reason: 'grant_always' }
    // Sensitive + no grant → confirm regardless of mode
    return url
  }

  // 4. Non-sensitive URL — apply mode
  if (input.mode === 'skip') return { verdict: 'allow', reason: 'mode_skip' }
  if (input.mode === 'auto') return { verdict: 'allow', reason: 'mode_auto' }
  return { verdict: 'confirm', reason: 'mode_manual' }
}

// ── Helpers ────────────────────────────────────────────────

function extractHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}
