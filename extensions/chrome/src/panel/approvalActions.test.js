import { test } from 'node:test'
import assert from 'node:assert/strict'

import { approvalMessage } from './approvalActions.js'

test('approvalMessage distinguishes one-time and persistent approvals', () => {
  assert.deepEqual(approvalMessage('tool-1', 'once'), {
    type: 'tool:approve',
    toolCallId: 'tool-1',
    decision: 'once',
  })
  assert.deepEqual(approvalMessage('tool-1', 'always'), {
    type: 'tool:approve',
    toolCallId: 'tool-1',
    decision: 'always',
  })
})

test('approvalMessage rejects unsupported decisions', () => {
  assert.throws(() => approvalMessage('tool-1', 'deny'), /invalid_approval_decision/)
})
