import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createScheduler } from './scheduler.js'

test('queues one missed occurrence, schedules the next, and never catches up N times', async () => {
  const alarms = []
  const runs = []
  const notifications = []
  const now = Date.parse('2026-07-30T12:10:00Z')
  const routine = {
    id: 'routine-1',
    accountId: 'acct-a',
    revision: 2,
    name: 'Daily',
    startUrl: 'https://example.com',
    allowedOrigins: ['https://example.com'],
    variables: [],
    schedule: {
      enabled: true,
      frequency: 'daily',
      time: '09:00',
      timezone: 'America/Sao_Paulo',
      nextRunAt: Date.parse('2026-07-29T12:00:00Z'),
    },
  }
  const scheduler = createScheduler({
    routinesStore: {
      get: async () => routine,
      update: async (_accountId, _id, _revision, patch) => {
        Object.assign(routine, patch)
        routine.revision += 1
        return routine
      },
    },
    loadSession: async () => ({ accountId: 'acct-a', accessToken: 'token' }),
    ensureFreshSession: async () => ({ accountId: 'acct-a', accessToken: 'token' }),
    getSelectedModelId: async () => 'model-1',
    loadModels: async () => [{ id: 'model-1', supportsVision: true }],
    getNormalWindow: async () => ({ id: 1 }),
    createRunTab: async () => ({ id: 7 }),
    runRoutine: async (request) => runs.push(request),
    alarms: {
      create: (name, info) => alarms.push({ name, info }),
      clear: async () => true,
    },
    notify: async (notification) => notifications.push(notification),
    now: () => now,
  })

  await scheduler.handleAlarm({ name: 'verboo-routine:routine-1:acct-a' })

  assert.equal(runs.length, 1)
  assert.equal(runs[0].occurrenceKey, `routine-1:${Date.parse('2026-07-29T12:00:00Z')}`)
  assert.equal(alarms.length, 1)
  assert.equal(routine.schedule.nextRunAt, Date.parse('2026-07-31T12:00:00Z'))
  assert.equal(notifications.length, 0)
})

test('pauses and notifies when the active account or normal window is unavailable', async () => {
  const notifications = []
  const routine = {
    id: 'routine-1',
    accountId: 'acct-a',
    revision: 1,
    name: 'Daily',
    allowedOrigins: ['https://example.com'],
    variables: [],
    schedule: {
      enabled: true,
      frequency: 'daily',
      time: '09:00',
      timezone: 'America/Sao_Paulo',
      nextRunAt: 100,
    },
  }
  const scheduler = createScheduler({
    routinesStore: {
      get: async () => routine,
      update: async () => routine,
    },
    loadSession: async () => ({ accountId: 'acct-b', accessToken: 'token' }),
    ensureFreshSession: async () => null,
    getSelectedModelId: async () => 'model-1',
    loadModels: async () => [{ id: 'model-1' }],
    getNormalWindow: async () => null,
    createRunTab: async () => null,
    runRoutine: async () => {
      throw new Error('must_not_run')
    },
    alarms: { create: () => {}, clear: async () => true },
    notify: async (notification) => notifications.push(notification),
    now: () => 200,
  })

  const outcome = await scheduler.handleAlarm({
    name: 'verboo-routine:routine-1:acct-a',
  })
  assert.equal(outcome.status, 'paused')
  assert.equal(outcome.reason, 'account_mismatch')
  assert.equal(notifications.length, 1)
})

test('manual mode requires a persistent site grant before background execution', async () => {
  const notifications = []
  const routine = {
    id: 'routine-1',
    accountId: 'acct-a',
    revision: 1,
    name: 'Daily',
    startUrl: 'https://example.com',
    allowedOrigins: ['https://example.com'],
    variables: [],
    schedule: {
      enabled: true,
      frequency: 'daily',
      time: '09:00',
      timezone: 'America/Sao_Paulo',
      nextRunAt: 100,
    },
  }
  const scheduler = createScheduler({
    routinesStore: {
      get: async () => routine,
      update: async (_accountId, _id, _revision, patch) => {
        Object.assign(routine, patch)
        routine.revision += 1
        return routine
      },
    },
    loadSession: async () => ({ accountId: 'acct-a', accessToken: 'token' }),
    ensureFreshSession: async () => ({ accountId: 'acct-a', accessToken: 'token' }),
    getSelectedModelId: async () => 'model-1',
    loadModels: async () => [{ id: 'model-1' }],
    loadMode: async () => 'manual',
    getSiteGrant: async () => undefined,
    getNormalWindow: async () => ({ id: 1 }),
    createRunTab: async () => {
      throw new Error('must_not_create_tab')
    },
    runRoutine: async () => {
      throw new Error('must_not_run')
    },
    alarms: { create: () => {}, clear: async () => true },
    notify: async (notification) => notifications.push(notification),
    now: () => 200,
  })

  const outcome = await scheduler.handleAlarm({
    name: 'verboo-routine:routine-1:acct-a',
  })
  assert.equal(outcome.status, 'paused')
  assert.equal(outcome.reason, 'routine_approval_required')
  assert.equal(notifications.length, 1)
})

test('restores a missed alarm immediately without advancing its occurrence', async () => {
  const alarms = []
  const routine = {
    id: 'routine-1',
    accountId: 'acct-a',
    revision: 1,
    schedule: {
      enabled: true,
      frequency: 'daily',
      time: '09:00',
      timezone: 'America/Sao_Paulo',
      nextRunAt: 100,
    },
  }
  const scheduler = createScheduler({
    routinesStore: {
      list: async () => [routine],
      update: async () => {
        throw new Error('must_not_advance_before_alarm')
      },
    },
    alarms: {
      create: (name, info) => alarms.push({ name, info }),
      clear: async () => true,
    },
    now: () => 200,
  })

  const restored = await scheduler.syncAccount('acct-a')
  assert.equal(restored[0].schedule.nextRunAt, 100)
  assert.equal(alarms[0].info.when, 1_200)
})
