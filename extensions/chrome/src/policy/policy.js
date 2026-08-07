/**
 * policy.js — URL-based policy engine: hard blocks + site grants
 *
 * Hard blocks are non-bypassable (internal pages, store).
 * Sensitive URLs (login, payment) return "confirm" by default.
 * User allowlist/blocklist overrides via PolicyConfig.
 *
 * Multi-user: zero hardcoded path/user/token.
 *
 * @typedef {'general'|'credentials'|'payments'|'email'|'admin'|'sensitive'} SiteCategory
 * @typedef {'allow'|'deny'|'confirm'} PolicyVerdict
 *
 * @typedef {{ pattern: string; verdict: PolicyVerdict; category: SiteCategory; reason?: string }} SiteRule
 * @typedef {{ allowlist: SiteRule[]; blocklist: SiteRule[] }} PolicyConfig
 * @typedef {{ url: string; verdict: PolicyVerdict; matchedRule?: SiteRule; category: SiteCategory }} PolicyCheck
 */

// ── Built-in Hard Blocks (never overridable) ────────────────

/** @type {Array<{ pattern: RegExp; reason: string }>} */
const HARD_BLOCK_PATTERNS = [
  { pattern: /^chrome:\/\//i,                  reason: 'internal_chrome_page' },
  { pattern: /^chrome-extension:\/\//i,         reason: 'extension_page' },
  { pattern: /^about:/i,                        reason: 'internal_chrome_page' },
  { pattern: /^edge:\/\//i,                     reason: 'internal_chrome_page' },
  { pattern: /^https:\/\/chrome\.google\.com\/webstore\//i, reason: 'chrome_store' },
]

// ── Sensitive URL classifiers ──────────────────────────────

/**
 * Sensitive URL classifiers.
 *
 * Patterns use `(?:/|$|\?)` anchors so they match the path segment
 * whether it appears mid-path (`/login/foo`), at the end (`/login`),
 * or with a query string (`/login?next=/x`). Without the anchor the
 * regex `/\/login\//i` misses `/login` (no trailing slash), which is
 * the most common shape in real apps.
 *
 * @type {Array<{ pattern: RegExp; category: SiteCategory }>}
 */
const SENSITIVE_PATTERNS = [
  { pattern: /\/login(?:\/|$|\?)/i,        category: 'credentials' },
  { pattern: /\/sign[- ]?in(?:\/|$|\?)/i,   category: 'credentials' },
  { pattern: /\/auth(?:\/|$|\?)/i,           category: 'credentials' },
  { pattern: /\/bank(?:ing)?(?:\/|$|\?)/i,  category: 'payments' },
  { pattern: /\/checkout(?:\/|$|\?)/i,       category: 'payments' },
  { pattern: /\/payment(?:\/|$|\?)/i,        category: 'payments' },
  { pattern: /\/my-account(?:\/|$|\?)/i,     category: 'sensitive' },
  { pattern: /\.gov\.br\//i,                  category: 'admin' },
  { pattern: /^https:\/\/[a-z]+\.gov\//i,     category: 'admin' },
]

// ── Private helpers ────────────────────────────────────────

/** @param {string} url @returns {SiteCategory} */
function classifyUrl(url) {
  for (const r of SENSITIVE_PATTERNS) {
    if (r.pattern.test(url)) return r.category
  }
  return 'general'
}

// ── Public API ─────────────────────────────────────────────

/**
 * Check a raw URL against hard blocks then user policy.
 * @param {string} url
 * @param {PolicyConfig} [config]
 * @returns {PolicyCheck}
 */
export function checkUrl(url, config) {
  const category = classifyUrl(url)
  const lower = url.toLowerCase()

  // 1. Hard blocks (never overridable)
  for (const hb of HARD_BLOCK_PATTERNS) {
    if (hb.pattern.test(lower)) {
      return { url, verdict: 'deny', category, matchedRule: { pattern: hb.pattern.source, verdict: 'deny', category, reason: hb.reason } }
    }
  }

  // 2. User blocklist
  if (config?.blocklist) {
    for (const rule of config.blocklist) {
      if (new RegExp(rule.pattern, 'i').test(lower)) {
        return { url, verdict: rule.verdict, category, matchedRule: rule }
      }
    }
  }

  // 3. User allowlist
  if (config?.allowlist) {
    for (const rule of config.allowlist) {
      if (new RegExp(rule.pattern, 'i').test(lower)) {
        return { url, verdict: rule.verdict, category, matchedRule: rule }
      }
    }
  }

  // 4. Default — sensitive categories need confirmation
  if (category !== 'general') return { url, verdict: 'confirm', category }

  return { url, verdict: 'allow', category }
}

/**
 * Quick check: is this URL categorically blocked?
 * @param {string} url
 * @returns {boolean}
 */
export function isHardBlocked(url) {
  const lower = url.toLowerCase()
  return HARD_BLOCK_PATTERNS.some((hb) => hb.pattern.test(lower))
}
