import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  extractVariableNames,
  normalizeCommand,
  normalizeRoutineDraft,
} from './schema.js'

test('normalizes a slash command and extracts unique variables', () => {
  assert.equal(normalizeCommand(' Relatório Semanal '), 'relatorio-semanal')
  assert.deepEqual(
    extractVariableNames('Compare {{empresa}} com {{empresa}} em {{periodo}}.'),
    ['empresa', 'periodo'],
  )
})

test('normalizes supported local schedules and rejects invalid recurrence data', () => {
  const routine = normalizeRoutineDraft(
    {
      name: 'Monthly',
      instructions: 'Open the report.',
      schedule: {
        enabled: true,
        frequency: 'monthly',
        day: 31,
        time: '09:00',
        timezone: 'America/Sao_Paulo',
      },
    },
    'acct-a',
    { id: 'routine-1', updatedAt: 1 },
  )
  assert.equal(routine.schedule.day, 31)

  assert.throws(
    () => normalizeRoutineDraft(
      {
        name: 'Broken',
        instructions: 'Open the report.',
        schedule: {
          enabled: true,
          frequency: 'weekly',
          weekday: 9,
          time: '99:00',
          timezone: 'Invalid/Timezone',
        },
      },
      'acct-a',
      { id: 'routine-2', updatedAt: 1 },
    ),
    /schedule_/,
  )
})

test('normalizes conditional, structured output, and reusable sub-routine settings', () => {
  const routine = normalizeRoutineDraft(
    {
      name: 'Branching report',
      instructions: 'Review the page.',
      branch: {
        selector: '.status',
        contains: 'Ready',
        thenInstructions: 'Publish the report.',
        elseInstructions: 'Ask for an update.',
      },
      output: { format: 'csv', selector: 'table' },
      subroutineCommands: ['/collect-leads', 'collect-leads', '/collect-leads'],
    },
    'acct-a',
    { id: 'routine-3', updatedAt: 1 },
  )

  assert.deepEqual(routine.branch, {
    selector: '.status',
    contains: 'Ready',
    thenInstructions: 'Publish the report.',
    elseInstructions: 'Ask for an update.',
  })
  assert.deepEqual(routine.output, { format: 'csv', selector: 'table' })
  assert.deepEqual(routine.subroutineCommands, ['collect-leads'])
})
