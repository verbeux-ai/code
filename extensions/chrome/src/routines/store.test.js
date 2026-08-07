import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createRoutinesStore } from './store.js'

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

function createStore() {
  let sequence = 0
  let timestamp = 1_000
  return createRoutinesStore(
    createMemoryStorage(),
    { randomUUID: () => `routine-${++sequence}` },
    () => ++timestamp,
  )
}

test('creates routines and isolates them by account', async () => {
  const store = createStore()

  const created = await store.create('acct-a', {
    name: 'Weekly',
    instructions: 'Compare {{empresa}} this week.',
  })

  assert.equal(created.id, 'routine-1')
  assert.equal(created.accountId, 'acct-a')
  assert.equal(created.command, 'weekly')
  assert.equal(created.revision, 1)
  assert.deepEqual(created.variables, [
    { name: 'empresa', required: true, defaultValue: '' },
  ])
  assert.equal((await store.list('acct-a')).length, 1)
  assert.equal((await store.list('acct-b')).length, 0)
})

test('updates only the expected revision and never moves account ownership', async () => {
  const store = createStore()
  const created = await store.create('acct-a', {
    name: 'Weekly',
    instructions: 'Run report.',
  })

  await assert.rejects(
    store.update('acct-a', created.id, 0, { name: 'Stale' }),
    /routine_revision_conflict/,
  )

  const updated = await store.update('acct-a', created.id, 1, {
    name: 'Weekly report',
    accountId: 'acct-b',
  })
  assert.equal(updated.name, 'Weekly report')
  assert.equal(updated.accountId, 'acct-a')
  assert.equal(updated.revision, 2)
  assert.equal(await store.get('acct-b', created.id), null)
})

test('duplicates with a unique command and removes only account-owned routines', async () => {
  const store = createStore()
  const created = await store.create('acct-a', {
    name: 'Weekly',
    command: 'weekly',
    instructions: 'Run report.',
    schedule: {
      enabled: true,
      frequency: 'weekly',
      weekday: 1,
      time: '09:00',
      timezone: 'UTC',
    },
  })

  const duplicate = await store.duplicate('acct-a', created.id)
  assert.equal(duplicate.name, 'Weekly copy')
  assert.equal(duplicate.command, 'weekly-copy')
  assert.equal(duplicate.schedule, undefined)

  assert.equal(await store.remove('acct-b', created.id), false)
  assert.equal(await store.remove('acct-a', created.id), true)
  assert.equal(await store.get('acct-a', created.id), null)
})

test('does not mutate allowed origins from the submitted draft', async () => {
  const store = createStore()
  const draft = {
    name: 'Dashboard',
    instructions: 'Open the dashboard.',
    startUrl: 'https://example.com/dashboard',
    allowedOrigins: ['https://admin.example.com'],
  }

  await store.create('acct-a', draft)

  assert.deepEqual(draft.allowedOrigins, ['https://admin.example.com'])
})

test('keeps duplicate commands unique at the maximum command length', async () => {
  const store = createStore()
  const command = 'a'.repeat(64)
  const created = await store.create('acct-a', {
    name: 'Long command',
    command,
    instructions: 'Run.',
  })

  const firstCopy = await store.duplicate('acct-a', created.id)
  const secondCopy = await store.duplicate('acct-a', created.id)

  assert.equal(firstCopy.command.length, 64)
  assert.equal(secondCopy.command.length, 64)
  assert.notEqual(firstCopy.command, secondCopy.command)
})
