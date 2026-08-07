import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createRunStore } from './runStore.js'

function memoryStorage() {
  const values = new Map()
  return {
    async get(key) {
      return values.has(key) ? { [key]: structuredClone(values.get(key)) } : {}
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) {
        values.set(key, structuredClone(value))
      }
    },
  }
}

test('persists only allowed run-state transitions', async () => {
  let now = 100
  const store = createRunStore(memoryStorage(), () => ++now)
  const created = await store.create('acct-a', {
    id: 'run-1',
    routineId: 'routine-1',
    routineRevision: 1,
  })

  assert.equal(created.status, 'draft')
  await store.transition('acct-a', 'run-1', 'ready')
  await store.transition('acct-a', 'run-1', 'queued')
  await store.transition('acct-a', 'run-1', 'running')
  const completed = await store.transition('acct-a', 'run-1', 'completed', {
    assistantMessage: 'Done',
  })
  assert.equal(completed.status, 'completed')
  await assert.rejects(
    store.transition('acct-a', 'run-1', 'running'),
    /routine_run_transition_invalid/,
  )
})

test('isolates run history by account and bounds it to 50 entries', async () => {
  let now = 0
  const store = createRunStore(memoryStorage(), () => ++now)
  for (let index = 0; index < 52; index += 1) {
    await store.create('acct-a', {
      id: `run-${index}`,
      routineId: 'routine-1',
      routineRevision: 1,
      status: 'cancelled',
    })
  }

  const runs = await store.list('acct-a')
  assert.equal(runs.length, 50)
  assert.equal((await store.list('acct-b')).length, 0)
  assert.equal(runs[0].id, 'run-51')
})

test('deduplicates occurrence keys and recovers interrupted runs', async () => {
  const store = createRunStore(memoryStorage(), () => 100)
  await store.create('acct-a', {
    id: 'run-1',
    routineId: 'routine-1',
    routineRevision: 1,
    occurrenceKey: 'routine-1:123',
  })
  await assert.rejects(
    store.create('acct-a', {
      id: 'run-2',
      routineId: 'routine-1',
      routineRevision: 1,
      occurrenceKey: 'routine-1:123',
    }),
    /routine_occurrence_duplicate/,
  )
  await store.transition('acct-a', 'run-1', 'ready')
  await store.transition('acct-a', 'run-1', 'queued')
  await store.transition('acct-a', 'run-1', 'running')

  const recovered = await store.recoverInterrupted('acct-a')
  assert.equal(recovered[0].status, 'queued')
})

test('recovers approval waits as queued so the unconfirmed step can resume', async () => {
  const store = createRunStore(memoryStorage(), () => 100)
  await store.create('acct-a', {
    id: 'run-approval',
    routineId: 'routine-1',
    routineRevision: 1,
  })
  await store.transition('acct-a', 'run-approval', 'ready')
  await store.transition('acct-a', 'run-approval', 'queued')
  await store.transition('acct-a', 'run-approval', 'running')
  await store.transition('acct-a', 'run-approval', 'waiting_approval')

  const recovered = await store.recoverInterrupted('acct-a')
  assert.equal(recovered[0].status, 'queued')
})

test('appends bounded execution events without changing the run state', async () => {
  let now = 100
  const store = createRunStore(memoryStorage(), () => ++now)
  await store.create('acct-a', {
    id: 'run-events',
    routineId: 'routine-1',
    routineRevision: 1,
    status: 'queued',
    events: [],
  })

  const updated = await store.appendEvent('acct-a', 'run-events', {
    type: 'tool',
    name: 'read_page',
    success: true,
    durationMs: 42,
  })

  assert.equal(updated.status, 'queued')
  assert.equal(updated.events.length, 1)
  assert.equal(updated.events[0].type, 'tool')
  assert.equal(updated.events[0].at, 102)
})
