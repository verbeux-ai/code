import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createApprovalExecutor } from './approvedExecute.js'

const TOOL = Object.freeze({
  id: 'tool-1',
  name: 'click',
  risk: 'mutate',
  input: 'click selector=button',
  params: { selector: 'button' },
})

function approvalRequired() {
  return {
    ok: false,
    error: 'manual_needs_approval',
    policy: { allowed: false, needsApproval: true, reason: 'manual_needs_approval' },
    toolCall: structuredClone(TOOL),
    policyHost: 'example.com',
  }
}

test('approval executor persists an always grant before dispatching the approved call', async () => {
  const calls = []
  const grants = []
  const executeWithApproval = createApprovalExecutor(async (toolCall, context) => {
    calls.push({ toolCall, context })
    if (calls.length === 1) return approvalRequired()
    return {
      ok: true,
      result: 'clicked',
      policy: { allowed: true, needsApproval: false, reason: 'site_always_allowed' },
      toolCall,
    }
  })

  const result = await executeWithApproval(
    TOOL,
    async () => ({
      mode: 'manual',
      setSiteGrant: async (host, decision) => grants.push({ host, decision }),
    }),
    { request: async () => 'always' },
  )

  assert.equal(result.ok, true)
  assert.deepEqual(grants, [{ host: 'example.com', decision: 'always' }])
  assert.equal(calls.length, 2)
})

test('approval executor waits for approval and dispatches the exact canonical call once', async () => {
  const calls = []
  const events = []
  const execute = async (toolCall, context) => {
    calls.push({ toolCall, context })
    if (calls.length === 1) return approvalRequired()
    return {
      ok: true,
      result: 'clicked',
      policy: { allowed: true, needsApproval: false, reason: 'approved_once' },
      toolCall,
    }
  }
  const executeWithApproval = createApprovalExecutor(execute)

  const result = await executeWithApproval(
    { ...TOOL, risk: 'read', input: 'caller supplied' },
    async () => ({ mode: 'manual' }),
    {
      request: async ({ toolCall }) => {
        events.push(`request:${toolCall.input}`)
        return 'once'
      },
      onApprovalClosed: ({ decision }) => events.push(`closed:${decision}`),
    },
  )

  assert.equal(result.ok, true)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1].toolCall, TOOL)
  assert.deepEqual(calls[1].context.approvedTool, {
    id: TOOL.id,
    input: TOOL.input,
  })
  assert.deepEqual(events, [
    `request:${TOOL.input}`,
    'closed:once',
  ])
})

for (const decision of ['deny', 'cancelled', 'timeout']) {
  test(`approval executor never dispatches after ${decision}`, async () => {
    let calls = 0
    const executeWithApproval = createApprovalExecutor(async () => {
      calls += 1
      return approvalRequired()
    })

    const result = await executeWithApproval(
      TOOL,
      async () => ({ mode: 'manual' }),
      { request: async () => decision },
    )

    assert.equal(calls, 1)
    assert.equal(result.ok, false)
    assert.equal(result.error, decision === 'deny' ? 'denied_by_user' : decision)
  })
}

test('approval executor does not prompt for a hard denial', async () => {
  let requested = false
  let surfaced = null
  const executeWithApproval = createApprovalExecutor(async () => ({
    ok: false,
    error: 'hard_block',
    policy: { allowed: false, needsApproval: false, reason: 'hard_block' },
    toolCall: TOOL,
  }))

  const result = await executeWithApproval(
    TOOL,
    async () => ({ mode: 'skip' }),
    {
      request: async () => { requested = true; return 'once' },
      onPolicyDenied: (denial) => { surfaced = denial },
    },
  )

  assert.equal(result.error, 'hard_block')
  assert.equal(requested, false)
  assert.equal(surfaced.policy.reason, 'hard_block')
})
