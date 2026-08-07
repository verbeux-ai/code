import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyRecoverySuggestion } from './recoverySuggestion.js'

test('applies a recovery only after explicit acceptance and exact revision match', async () => {
  const routine = {
    id: 'routine-1',
    revision: 3,
    recordedSteps: [{ name: 'click', params: { selector: '#old' } }],
  }
  const run = {
    id: 'run-1',
    routineId: 'routine-1',
    recoverySuggestion: {
      stepIndex: 0,
      name: 'click',
      params: { selector: 'button.continue' },
      expectedRoutineRevision: 3,
    },
  }
  const result = await applyRecoverySuggestion({
    accountId: 'acct-a',
    runId: 'run-1',
    routinesStore: {
      get: async () => routine,
      update: async (_accountId, _id, revision, patch) => ({
        ...routine,
        ...patch,
        revision: revision + 1,
      }),
    },
    runStore: {
      get: async () => run,
      patch: async (_accountId, _id, patch) => ({ ...run, ...patch }),
    },
    now: () => 123,
  })

  assert.equal(
    result.routine.recordedSteps[0].params.selector,
    'button.continue',
  )
  assert.equal(result.run.recoverySuggestion, null)
  assert.equal(result.run.recoverySuggestionAppliedAt, 123)
})

test('rejects a stale recovery suggestion without changing selectors', async () => {
  await assert.rejects(
    applyRecoverySuggestion({
      accountId: 'acct-a',
      runId: 'run-1',
      routinesStore: {
        get: async () => ({ id: 'routine-1', revision: 4, recordedSteps: [{}] }),
      },
      runStore: {
        get: async () => ({
          id: 'run-1',
          routineId: 'routine-1',
          recoverySuggestion: {
            stepIndex: 0,
            expectedRoutineRevision: 3,
          },
        }),
      },
    }),
    /routine_revision_conflict/,
  )
})
