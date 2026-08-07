/**
 * Hard Block definitions — non-bypassable action classes the agent must
 * never execute, including under Skip mode.
 *
 * Each Hard Block has a `match` predicate (pure function) and an optional
 * `riskLabel` for display.
 *
 * Multi-user: zero hardcoded paths, users, tokens.
 */

/** @typedef {{ label: string; match: (input: string) => boolean }} HardBlockRule */

/** @type {HardBlockRule[]} */
export const HARD_BLOCKS = [
  {
    label: 'purchase',
    match(input) {
      const keywords = [
        /purchase/i, /buy\b/i, /checkout/i, /add-to-cart/i,
        /place\s*order/i, /confirm\s*purchase/i, /complete\s*purchase/i,
        /pay\b/i, /payment/i, /charge/i, /transaction/i,
      ]
      return keywords.some((re) => re.test(input))
    },
  },
  {
    label: 'create_account',
    match(input) {
      const keywords = [
        /create\s*account/i, /sign\s*up/i, /register/i,
        /create\s*profile/i, /create\s*user/i,
      ]
      return keywords.some((re) => re.test(input))
    },
  },
  {
    label: 'financial_trade',
    match(input) {
      const keywords = [
        /trade/i, /invest/i, /buy\s*stock/i, /sell\s*stock/i,
        /place\s*trade/i, /execute\s*trade/i, /crypto/i,
        /swap\b/i, /stake/i,
      ]
      return keywords.some((re) => re.test(input))
    },
  },
  {
    label: 'mass_permanent_deletion',
    match(input) {
      const keywords = [
        /delete\s*(all|every|entire)\s/i, /remove\s*(all|every|entire)\s/i,
        /clear\s*(all|every|entire)\s/i, /wipe\s/i, /purge\s/i,
        /destroy\s/i, /nuke\s/i,
      ]
      return keywords.some((re) => re.test(input))
    },
  },
  {
    label: 'secret_exposure',
    match(input) {
      const keywords = [
        /paste\s*secret/i, /reveal\s*password/i, /show\s*api.?key/i,
        /expose\s*token/i, /leak\s*credential/i, /dump\s*env/i,
        /print\s*secret/i, /display\s*password/i, /output\s*.env/i,
      ]
      return keywords.some((re) => re.test(input))
    },
  },
  {
    label: 'prompt_injection_obedience',
    match(input) {
      const keywords = [
        /ignore\s*(your|system|user)\s*(instructions|policy|rules)/i,
        /disregard\s*(your|prior|previous)\s*(instructions|directives)/i,
        /override\s*system\s*prompt/i, /you\s*must\s*obey/i,
        /you\s*must\s*ignore/i,
      ]
      return keywords.some((re) => re.test(input))
    },
  },
]

/**
 * Check if a tool/action description matches any Hard Block.
 * @param {string} input — tool name + params as a single string to check
 * @returns {{ blocked: boolean; matchedLabel?: string }}
 */
export function checkHardBlock(input) {
  const subject = hardBlockSubject(input)
  const match = HARD_BLOCKS.find((rule) => rule.match(subject))
  return match
    ? { blocked: true, matchedLabel: match.label }
    : { blocked: false }
}

function hardBlockSubject(input) {
  if (!input || typeof input !== 'object') return String(input ?? '')
  const name = typeof input.name === 'string' ? input.name : ''
  const params = input.params && typeof input.params === 'object' ? input.params : {}
  if (name === 'click') {
    return params.selector == null
      ? String(input.input ?? name)
      : `click selector=${String(params.selector)}`
  }
  if (name === 'type') {
    if (params.selector == null && params.text == null) return String(input.input ?? name)
    return `type selector=${String(params.selector ?? '')} text=${String(params.text ?? '')}`
  }
  // URLs are destinations, not proof of a purchase/account/trade action.
  // Navigating to /buy or /register may be needed for harmless inspection.
  return name
}
