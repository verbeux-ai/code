import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MSG } from '../controller/protocol.js'
import { createRoutinesStore } from './store.js'
import { createRoutineMessageHandler } from './messageHandler.js'

function createMemoryStorage() {
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

function createHandler(session = { accountId: 'acct-a', accessToken: 'token' }) {
  let sequence = 0
  const events = []
  const changes = []
  const store = createRoutinesStore(
    createMemoryStorage(),
    { randomUUID: () => `routine-${++sequence}` },
    () => 1_000 + sequence,
  )
  const handle = createRoutineMessageHandler({
    store,
    loadSession: async () => session,
    broadcast: (event) => events.push(event),
    onRoutineChanged: async (routine, change) => {
      changes.push({ routine, change })
      return routine
    },
  })
  return { handle, events, changes }
}

test('creates and lists routines for the authenticated account', async () => {
  const { handle, events } = createHandler()

  const created = await handle({
    type: MSG.ROUTINE_CREATE,
    draft: { name: 'Daily', instructions: 'Open dashboard.' },
  })
  const listed = await handle({ type: MSG.ROUTINE_LIST })

  assert.equal(created.ok, true)
  assert.equal(created.routine.accountId, 'acct-a')
  assert.equal(listed.ok, true)
  assert.equal(listed.routines.length, 1)
  assert.equal(events[0].type, MSG.ROUTINE_STATE_CHANGED)
})

test('rejects routine access without an authenticated account', async () => {
  const { handle } = createHandler(null)

  assert.deepEqual(
    await handle({ type: MSG.ROUTINE_LIST }),
    { ok: false, error: 'auth_required' },
  )
})

test('updates, duplicates, gets, and deletes through the message contract', async () => {
  const { handle, events, changes } = createHandler()
  const created = await handle({
    type: MSG.ROUTINE_CREATE,
    draft: { name: 'Daily', instructions: 'Open dashboard.' },
  })

  const updated = await handle({
    type: MSG.ROUTINE_UPDATE,
    id: created.routine.id,
    expectedRevision: 1,
    patch: { name: 'Morning dashboard' },
  })
  const duplicate = await handle({
    type: MSG.ROUTINE_DUPLICATE,
    id: created.routine.id,
  })
  const fetched = await handle({
    type: MSG.ROUTINE_GET,
    id: duplicate.routine.id,
  })
  const removed = await handle({
    type: MSG.ROUTINE_DELETE,
    id: created.routine.id,
  })

  assert.equal(updated.routine.revision, 2)
  assert.equal(duplicate.routine.command, 'daily-copy')
  assert.equal(fetched.routine.id, duplicate.routine.id)
  assert.deepEqual(removed, { ok: true, removed: true })
  assert.equal(events.length, 4)
  assert.deepEqual(
    changes.map(({ change }) => change),
    ['created', 'updated', 'duplicated', 'deleted'],
  )
})

test('returns a stable error envelope for storage failures and unknown messages', async () => {
  const { handle } = createHandler()

  assert.deepEqual(
    await handle({ type: MSG.ROUTINE_GET, id: 'missing' }),
    { ok: true, routine: null },
  )
  assert.deepEqual(
    await handle({ type: 'routine:unknown' }),
    { ok: false, error: 'routine_message_unsupported' },
  )
})
