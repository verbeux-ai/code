/**
 * evaluateToolPolicy — unified policy gate for Browser Tools.
 *
 * Combines Hard Blocks + Chrome Permission Mode + Site Grant into a single
 * decision. The Browser Controller (P2) MUST call this before executing any
 * tool. Clients (Desktop Bridge in P4) cannot bypass it.
 *
 * Decision contract:
 *   - Hard Blocks ALWAYS block, including under Skip mode.
 *   - Site Grant `deny` ALWAYS blocks, including under Skip mode.
 *   - Site Grant `always` allows without prompt (regardless of mode).
 *   - Site Grant `once` allows this call but does not persist (caller
 *     decides whether to upgrade to `always` after success).
 *   - No grant + Manual mode → `needsApproval` (caller prompts the user).
 *   - No grant + Auto mode → `allowed` (safety checks still ran; hard
 *     blocks + deny already returned above).
 *   - No grant + Skip mode → `allowed` (hard blocks + deny still apply).
 *   - Elevated tools (risk === 'elevated') ALWAYS `needsApproval`, even
 *     under Auto/Skip and even with `always` grant. This matches the
 *     design spec §6.3: "Elevated always re-prompts".
 *
 * Pure function — no chrome.* calls. Caller supplies mode + grant + tool.
 *
 * @typedef {'manual' | 'auto' | 'skip'} ChromePermissionMode
 * @typedef {'once' | 'always' | 'deny'} GrantDecision
 * @typedef {'read' | 'mutate' | 'elevated'} ToolRisk
 * @typedef {{ name: string; risk: ToolRisk; input: string }} ToolCall
 *   - `input` is the tool name + params joined as a single string for
 *     Hard Block matching (e.g. "navigate https://example.com" or
 *     "click button#buy-now"). The Hard Block rules are regex-based and
 *     intentionally loose; the controller shapes the input.
 *
 * @typedef {{ allowed: boolean; needsApproval: boolean; reason: string; hardBlockLabel?: string }} PolicyDecision
 */

import { checkHardBlock } from './hardBlocks.js'

/**
 * @param {ChromePermissionMode} mode
 * @param {GrantDecision | undefined} siteGrant
 * @param {ToolCall} toolCall
 * @returns {PolicyDecision}
 */
export function evaluateToolPolicy(mode, siteGrant, toolCall) {
  if (!toolCall || typeof toolCall !== 'object' || !toolCall.name) {
    return { allowed: false, needsApproval: false, reason: 'invalid_tool_call' }
  }

  // 1. Hard Blocks — always apply, including under Skip.
  const hb = checkHardBlock(toolCall)
  if (hb.blocked) {
    return {
      allowed: false,
      needsApproval: false,
      reason: 'hard_block',
      hardBlockLabel: hb.matchedLabel,
    }
  }

  // 2. Elevated tools — always re-prompt, even Auto/Skip, even `always`.
  if (toolCall.risk === 'elevated') {
    return { allowed: false, needsApproval: true, reason: 'elevated_requires_approval' }
  }

  // 3. Site Grant `deny` — always blocks.
  if (siteGrant === 'deny') {
    return { allowed: false, needsApproval: false, reason: 'site_denied' }
  }

  // 4. Site Grant `always` — allow without prompt.
  if (siteGrant === 'always') {
    return { allowed: true, needsApproval: false, reason: 'site_always_allowed' }
  }

  // 5. Site Grant `once` — allow this call (caller decides persistence).
  if (siteGrant === 'once') {
    return { allowed: true, needsApproval: false, reason: 'site_once_allowed' }
  }

  // 6. No grant — apply mode.
  //    Manual: needs approval before mutate; reads still need approval in
  //    Manual per design §7.1 ("Plan or per-action approval before mutate").
  //    We treat reads in Manual as also needing approval to keep the UX
  //    predictable; the controller can short-circuit reads if it wants.
  if (mode === 'manual') {
    return { allowed: false, needsApproval: true, reason: 'manual_needs_approval' }
  }

  // 7. Auto / Skip with no grant — allow. Hard blocks + deny already
  //    returned above. Skip mode "no routine prompts; hard blocks still
  //    enforced" (design §7.1).
  if (mode === 'auto' || mode === 'skip') {
    return { allowed: true, needsApproval: false, reason: mode === 'auto' ? 'auto_no_grant' : 'skip_no_grant' }
  }

  // Unknown mode — fail safe (treat as manual).
  return { allowed: false, needsApproval: true, reason: 'unknown_mode' }
}

/**
 * Convenience: returns true iff the decision is a Hard Block.
 * Used by callers to surface Hard Block denials distinctly in the UI
 * (acceptance criterion P1: "Skip mode still surfaces Hard Block denials").
 * @param {PolicyDecision} decision
 * @returns {boolean}
 */
export function isHardBlockDenial(decision) {
  return decision?.reason === 'hard_block'
}
