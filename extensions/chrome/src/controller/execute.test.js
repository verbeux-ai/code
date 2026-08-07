/**
 * execute.test.js — unit tests for the Browser Controller execute() gate.
 *
 * Run with: node --test src/controller/execute.test.js
 *
 * Mocks chrome.tabs and chrome.scripting for pure-logic verification.
 * Tool implementation tests (navigate, click, etc.) live in tools/*.test.js.
 */

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

// ── Setup chrome mocks ──────────────────────────────────────
const fakeTabs = new Map()
let currentWindowTabId = 42
globalThis.chrome = {
  tabs: {
    query: async (opts) => {
      if (opts?.active && opts?.currentWindow) {
        const tab = fakeTabs.get(currentWindowTabId) ?? { id: currentWindowTabId, url: 'https://example.com', title: 'Example' }
        return [tab]
      }
      return Array.from(fakeTabs.values())
    },
    get: async (id) => fakeTabs.get(id) ?? { id, url: 'https://example.com' },
    update: async (id) => { /* noop */ },
  },
  scripting: {
    executeScript: async () => [{ result: 'mocked' }],
  },
  storage: {
    local: {
      get: async () => ({}),
      set: async () => {},
    },
  },
}

// Register a default tab so queries work.
fakeTabs.set(42, { id: 42, url: 'https://example.com', active: true, windowId: 1, title: 'Example' })

const { execute } = await import('./execute.js')

function makeCtx(overrides = {}) {
  return {
    mode: 'manual',
    getSiteGrant: async () => undefined,
    activeTabId: 42,
    ...overrides,
  }
}

// ── Tests: policy gate enforces before any tool runs ─────────

test('execute: hard blocked tool returns policy denial (no dispatch)', async () => {
  const r = await execute(
    { name: 'click', params: { selector: 'button[aria-label="Buy Now"]' } },
    makeCtx(),
  )
  assert.equal(r.ok, false)
  assert.equal(r.policy.reason, 'hard_block')
  assert.equal(r.policy.hardBlockLabel, 'purchase')
})

test('execute: site denied returns policy denial', async () => {
  const r = await execute(
    { name: 'read_page', params: { selector: 'h1' } },
    makeCtx({ mode: 'skip', getSiteGrant: async () => 'deny' }),
  )
  assert.equal(r.ok, false)
  assert.equal(r.policy.reason, 'site_denied')
})

test('execute: manual + no grant + mutate returns needsApproval (no dispatch)', async () => {
  const r = await execute(
    { name: 'click', params: { selector: 'button[type="submit"]' } },
    makeCtx({ mode: 'manual' }),
  )
  assert.equal(r.ok, false)
  assert.equal(r.policy.reason, 'manual_needs_approval')
  assert.equal(r.policy.needsApproval, true)
})

test('execute: skip + no grant + mutate dispatches and returns result', async () => {
  const r = await execute(
    { name: 'read_page', params: { selector: 'h1' } },
    makeCtx({ mode: 'skip' }),
  )
  assert.equal(r.ok, true)
  assert.ok(r.result != null)
  assert.equal(r.policy.reason, 'skip_no_grant')
})

test('execute: site always + mutate dispatches', async () => {
  const r = await execute(
    { name: 'read_page', params: { selector: 'h1' } },
    makeCtx({ mode: 'manual', getSiteGrant: async () => 'always' }),
  )
  assert.equal(r.ok, true)
  assert.equal(r.policy.reason, 'site_always_allowed')
})

test('execute: invalid tool call returns error', async () => {
  const r = await execute(null, makeCtx())
  assert.equal(r.ok, false)
  assert.equal(r.policy.reason, 'invalid_tool_call')
})

test('execute: unknown tool name returns error', async () => {
  const r = await execute(
    { name: 'unknown_tool_xyz', params: {} },
    makeCtx({ mode: 'skip' }),
  )
  assert.equal(r.ok, false)
  assert.equal(r.error, 'unknown_tool')
})

// ── Tests: execute returns policy in every response ─────────
test('execute: policy field always present in result', async () => {
  // Allowed case
  const r = await execute(
    { name: 'read_page', params: { selector: 'h1' } },
    makeCtx({ mode: 'skip' }),
  )
  assert.ok(r.policy != null)

  // Denied case
  const d = await execute(null, makeCtx())
  assert.ok(d.policy != null)
})

test('execute: rebuilds risk and hard-block input instead of trusting the caller', async () => {
  const r = await execute(
    {
      id: 'downgrade-attempt',
      name: 'click',
      risk: 'read',
      input: 'harmless',
      params: { selector: 'button[aria-label="Buy Now"]' },
    },
    makeCtx({ mode: 'skip', getSiteGrant: async () => 'always' }),
  )

  assert.equal(r.ok, false)
  assert.equal(r.policy.reason, 'hard_block')
  assert.equal(r.toolCall.risk, 'mutate')
  assert.match(r.toolCall.input, /Buy Now/)
})

test('execute: resolves navigate grants from the destination origin', async () => {
  const seen = []
  const r = await execute(
    {
      id: 'navigate-destination',
      name: 'navigate',
      params: { url: 'https://destination.example/path' },
    },
    makeCtx({
      mode: 'skip',
      getSiteGrant: async (host) => {
        seen.push(host)
        return 'deny'
      },
    }),
  )

  assert.equal(r.ok, false)
  assert.equal(r.policy.reason, 'site_denied')
  assert.deepEqual(seen, ['destination.example'])
})

test('execute: returns the resolved policy host to the approval state machine', async () => {
  const r = await execute(
    { id: 'approval-host', name: 'read_page', params: { selector: 'h1' } },
    makeCtx({ mode: 'manual' }),
  )

  assert.equal(r.policy.needsApproval, true)
  assert.equal(r.policyHost, 'example.com')
})

test('execute: rejects missing required parameters before approval', async () => {
  const r = await execute(
    { id: 'missing-selector', name: 'click', params: {} },
    makeCtx({ mode: 'manual' }),
  )

  assert.equal(r.ok, false)
  assert.equal(r.error, 'invalid_params:selector_required')
  assert.equal(r.policy.reason, 'invalid_tool_call')
})

test('execute: rejects tools outside the canonical catalog', async () => {
  const r = await execute(
    { id: 'unknown', name: 'unknown_tool_xyz', risk: 'read', input: 'harmless', params: {} },
    makeCtx({ mode: 'skip' }),
  )

  assert.equal(r.ok, false)
  assert.equal(r.error, 'unknown_tool')
  assert.equal(r.policy.reason, 'unknown_tool')
})

test('execute: an exact controller approval authorizes only that canonical call', async () => {
  const approved = await execute(
    { id: 'approved-call', name: 'read_page', params: { selector: 'h1' } },
    makeCtx({
      mode: 'manual',
      approvedTool: { id: 'approved-call', input: 'read_page selector=h1' },
    }),
  )
  assert.equal(approved.ok, true)
  assert.equal(approved.policy.reason, 'approved_once')

  const changed = await execute(
    { id: 'approved-call', name: 'read_page', params: { selector: 'main' } },
    makeCtx({
      mode: 'manual',
      approvedTool: { id: 'approved-call', input: 'read_page selector=h1' },
    }),
  )
  assert.equal(changed.ok, false)
  assert.equal(changed.policy.reason, 'manual_needs_approval')
})
