import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createRecordingController } from './controller.js'

function memoryStorage() {
  let value = {}
  return {
    async get(key) {
      return { [key]: structuredClone(value[key]) }
    },
    async set(items) {
      value = { ...value, ...structuredClone(items) }
    },
    async remove(key) {
      delete value[key]
    },
  }
}

test('records only the selected account and tab, then returns a private draft', async () => {
  const sent = []
  const states = []
  let sequence = 0
  const controller = createRecordingController({
    storage: memoryStorage(),
    sendToTab: async (tabId, message) => sent.push({ tabId, message }),
    onState: (state) => states.push(state),
    cryptoImpl: { randomUUID: () => `recording-${++sequence}` },
    now: () => 100,
  })

  await controller.start('acct-a', 7)
  assert.equal(await controller.recordEvent(8, {
    kind: 'click',
    url: 'https://example.com',
  }), false)
  assert.equal(await controller.recordEvent(7, {
    kind: 'input',
    url: 'https://example.com',
    selectorCandidates: ['input[name="company"]'],
    field: { type: 'text', name: 'company' },
    value: 'Acme',
    timestamp: 101,
  }), true)

  const stopped = await controller.stop('acct-a')
  assert.equal(stopped.draft.recordedSteps.length, 1)
  assert.doesNotMatch(JSON.stringify(stopped.draft), /Acme/)
  assert.equal(sent[0].message.type, 'routine:recorder_enable')
  assert.equal(sent.at(-1).message.type, 'routine:recorder_disable')
  assert.equal(states.at(-1).active, false)
})

test('rejects conflicting recording ownership and supports cancellation', async () => {
  const controller = createRecordingController({
    storage: memoryStorage(),
    sendToTab: async () => {},
    onState: () => {},
    cryptoImpl: { randomUUID: () => 'recording-1' },
    now: () => 100,
  })

  await controller.start('acct-a', 7)
  await assert.rejects(controller.start('acct-b', 8), /routine_recording_active/)
  assert.equal(await controller.cancel('acct-b'), false)
  assert.equal(await controller.cancel('acct-a'), true)
})
