import { test } from 'node:test'
import assert from 'node:assert/strict'

import { replayRecordedSteps } from './replay.js'

test('replays deterministic steps and checkpoints only confirmed work', async () => {
  const checkpoints = []
  const calls = []
  const outcome = await replayRecordedSteps({
    steps: [{ name: 'navigate', params: { url: 'https://example.com' } }],
    startIndex: 0,
    execute: async (toolCall) => {
      calls.push(toolCall)
      return { ok: true, result: { url: 'https://example.com' } }
    },
    checkpoint: async (index) => checkpoints.push(index),
  })

  assert.deepEqual(outcome, {
    status: 'completed',
    nextIndex: 1,
    completedSteps: 1,
  })
  assert.deepEqual(checkpoints, [1])
  assert.equal(calls[0].name, 'navigate')
})

test('hands one failed step to semantic recovery without retrying it', async () => {
  let attempts = 0
  const step = {
    name: 'click',
    params: { selector: '#old' },
    semantic: {
      accessibleName: 'Continue',
      selectorCandidates: ['#old', 'button.continue'],
    },
  }
  const outcome = await replayRecordedSteps({
    steps: [step],
    startIndex: 0,
    execute: async () => {
      attempts += 1
      return { ok: false, error: 'element_not_found:#old' }
    },
    checkpoint: async () => {},
  })

  assert.equal(attempts, 1)
  assert.equal(outcome.status, 'needs_recovery')
  assert.equal(outcome.nextIndex, 0)
  assert.equal(outcome.completedSteps, 0)
  assert.equal(outcome.failure.step.name, 'click')
  assert.equal(outcome.failure.semantic.accessibleName, 'Continue')
  assert.match(outcome.failure.error, /element_not_found/)
})

test('stops immediately when cancelled', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    replayRecordedSteps({
      steps: [{ name: 'click', params: { selector: '#x' } }],
      startIndex: 0,
      execute: async () => ({ ok: true }),
      checkpoint: async () => {},
      signal: controller.signal,
    }),
    /run_cancelled/,
  )
})

test('does not reinterpret an approval denial as a selector recovery', async () => {
  await assert.rejects(
    replayRecordedSteps({
      steps: [{ name: 'click', params: { selector: '#x' } }],
      execute: async () => ({ ok: false, error: 'denied_by_user' }),
      checkpoint: async () => {},
    }),
    /denied_by_user/,
  )
})
