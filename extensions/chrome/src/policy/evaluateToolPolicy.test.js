/**
 * evaluateToolPolicy.test.js — tests for the unified tool policy gate.
 *
 * Run with: node --test src/policy/evaluateToolPolicy.test.js
 *
 * Covers the decision matrix:
 *   - Hard blocks always block (incl. Skip mode)
 *   - Site deny always blocks (incl. Skip mode)
 *   - Site always allows without prompt
 *   - Site once allows this call
 *   - Manual mode + no grant → needsApproval
 *   - Auto/Skip + no grant → allowed (hard blocks already returned)
 *   - Elevated tools always need approval (even Auto/Skip, even `always`)
 *   - Invalid tool call → blocked
 *   - Unknown mode → fail safe (needsApproval)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateToolPolicy, isHardBlockDenial } from './evaluateToolPolicy.js'

const readTool = { name: 'read_page', risk: 'read', input: 'read_page selector=h1' }
const mutateTool = { name: 'click', risk: 'mutate', input: 'click text=Submit' }
const purchaseTool = { name: 'click', risk: 'mutate', input: 'click text=Buy Now' }
const elevatedTool = { name: 'file_upload', risk: 'elevated', input: 'file_upload path=/etc/passwd' }

// ── Hard Blocks always apply ─────────────────────────────────

test('hard block: blocks under manual mode', () => {
  const d = evaluateToolPolicy('manual', undefined, purchaseTool)
  assert.equal(d.allowed, false)
  assert.equal(d.needsApproval, false)
  assert.equal(d.reason, 'hard_block')
  assert.equal(d.hardBlockLabel, 'purchase')
})

test('hard block: blocks under auto mode', () => {
  const d = evaluateToolPolicy('auto', undefined, purchaseTool)
  assert.equal(d.allowed, false)
  assert.equal(d.reason, 'hard_block')
})

test('hard block: blocks under skip mode (acceptance criterion P1)', () => {
  const d = evaluateToolPolicy('skip', undefined, purchaseTool)
  assert.equal(d.allowed, false)
  assert.equal(d.reason, 'hard_block')
  assert.equal(d.hardBlockLabel, 'purchase')
})

test('hard block: blocks even with site grant=always', () => {
  const d = evaluateToolPolicy('skip', 'always', purchaseTool)
  assert.equal(d.allowed, false)
  assert.equal(d.reason, 'hard_block')
})

test('isHardBlockDenial: true for hard_block reason', () => {
  const d = evaluateToolPolicy('skip', undefined, purchaseTool)
  assert.equal(isHardBlockDenial(d), true)
})

test('isHardBlockDenial: false for other denials', () => {
  const d = evaluateToolPolicy('manual', undefined, mutateTool)
  assert.equal(isHardBlockDenial(d), false)
})

// ── Site Grant deny always blocks ───────────────────────────

test('site deny: blocks under manual', () => {
  const d = evaluateToolPolicy('manual', 'deny', mutateTool)
  assert.equal(d.allowed, false)
  assert.equal(d.reason, 'site_denied')
})

test('site deny: blocks under skip', () => {
  const d = evaluateToolPolicy('skip', 'deny', mutateTool)
  assert.equal(d.allowed, false)
  assert.equal(d.reason, 'site_denied')
})

test('site deny: blocks even for read tools', () => {
  const d = evaluateToolPolicy('auto', 'deny', readTool)
  assert.equal(d.allowed, false)
  assert.equal(d.reason, 'site_denied')
})

// ── Site Grant always ───────────────────────────────────────

test('site always: allows without prompt under manual', () => {
  const d = evaluateToolPolicy('manual', 'always', mutateTool)
  assert.equal(d.allowed, true)
  assert.equal(d.needsApproval, false)
  assert.equal(d.reason, 'site_always_allowed')
})

test('site always: allows under skip', () => {
  const d = evaluateToolPolicy('skip', 'always', mutateTool)
  assert.equal(d.allowed, true)
  assert.equal(d.reason, 'site_always_allowed')
})

// ── Site Grant once ─────────────────────────────────────────

test('site once: allows this call under manual', () => {
  const d = evaluateToolPolicy('manual', 'once', mutateTool)
  assert.equal(d.allowed, true)
  assert.equal(d.needsApproval, false)
  assert.equal(d.reason, 'site_once_allowed')
})

test('site once: allows under skip', () => {
  const d = evaluateToolPolicy('skip', 'once', mutateTool)
  assert.equal(d.allowed, true)
  assert.equal(d.reason, 'site_once_allowed')
})

// ── No grant + Manual → needsApproval ───────────────────────

test('manual + no grant + mutate → needsApproval', () => {
  const d = evaluateToolPolicy('manual', undefined, mutateTool)
  assert.equal(d.allowed, false)
  assert.equal(d.needsApproval, true)
  assert.equal(d.reason, 'manual_needs_approval')
})

test('manual + no grant + read → needsApproval (predictable UX)', () => {
  const d = evaluateToolPolicy('manual', undefined, readTool)
  assert.equal(d.allowed, false)
  assert.equal(d.needsApproval, true)
  assert.equal(d.reason, 'manual_needs_approval')
})

// ── No grant + Auto/Skip → allowed ─────────────────────────

test('auto + no grant → allowed', () => {
  const d = evaluateToolPolicy('auto', undefined, mutateTool)
  assert.equal(d.allowed, true)
  assert.equal(d.needsApproval, false)
  assert.equal(d.reason, 'auto_no_grant')
})

test('skip + no grant → allowed', () => {
  const d = evaluateToolPolicy('skip', undefined, mutateTool)
  assert.equal(d.allowed, true)
  assert.equal(d.needsApproval, false)
  assert.equal(d.reason, 'skip_no_grant')
})

// ── Elevated tools always re-prompt ────────────────────────

test('elevated: needsApproval under manual', () => {
  const d = evaluateToolPolicy('manual', undefined, elevatedTool)
  assert.equal(d.needsApproval, true)
  assert.equal(d.reason, 'elevated_requires_approval')
})

test('elevated: needsApproval under auto', () => {
  const d = evaluateToolPolicy('auto', undefined, elevatedTool)
  assert.equal(d.needsApproval, true)
  assert.equal(d.reason, 'elevated_requires_approval')
})

test('elevated: needsApproval under skip', () => {
  const d = evaluateToolPolicy('skip', undefined, elevatedTool)
  assert.equal(d.needsApproval, true)
  assert.equal(d.reason, 'elevated_requires_approval')
})

test('elevated: needsApproval even with site grant=always', () => {
  const d = evaluateToolPolicy('skip', 'always', elevatedTool)
  assert.equal(d.needsApproval, true)
  assert.equal(d.reason, 'elevated_requires_approval')
})

// ── Invalid input ──────────────────────────────────────────

test('invalid: null toolCall → blocked', () => {
  const d = evaluateToolPolicy('manual', undefined, null)
  assert.equal(d.allowed, false)
  assert.equal(d.reason, 'invalid_tool_call')
})

test('invalid: missing name → blocked', () => {
  const d = evaluateToolPolicy('manual', undefined, { risk: 'read' })
  assert.equal(d.allowed, false)
  assert.equal(d.reason, 'invalid_tool_call')
})

test('unknown mode → fail safe (needsApproval)', () => {
  const d = evaluateToolPolicy('yolo', undefined, mutateTool)
  assert.equal(d.allowed, false)
  assert.equal(d.needsApproval, true)
  assert.equal(d.reason, 'unknown_mode')
})
