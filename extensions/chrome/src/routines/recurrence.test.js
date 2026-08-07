import { test } from 'node:test'
import assert from 'node:assert/strict'

import { nextOccurrence, occurrenceKey } from './recurrence.js'

const timezone = 'America/Sao_Paulo'

test('calculates daily and weekly occurrences in calendar time', () => {
  assert.equal(
    nextOccurrence(
      { frequency: 'daily', time: '09:00', timezone },
      Date.parse('2026-07-29T12:01:00Z'),
    ),
    Date.parse('2026-07-30T12:00:00Z'),
  )
  assert.equal(
    nextOccurrence(
      { frequency: 'weekly', weekday: 1, time: '09:00', timezone },
      Date.parse('2026-08-03T12:01:00Z'),
    ),
    Date.parse('2026-08-10T12:00:00Z'),
  )
})

test('clamps monthly and annual dates to the last valid local day', () => {
  assert.equal(
    nextOccurrence(
      { frequency: 'monthly', day: 31, time: '09:00', timezone },
      Date.parse('2027-01-31T12:01:00Z'),
    ),
    Date.parse('2027-02-28T12:00:00Z'),
  )
  assert.equal(
    nextOccurrence(
      { frequency: 'annual', month: 2, day: 29, time: '09:00', timezone },
      Date.parse('2027-01-01T12:00:00Z'),
    ),
    Date.parse('2027-02-28T12:00:00Z'),
  )
})

test('builds a stable occurrence key', () => {
  assert.equal(
    occurrenceKey('routine-1', 1_234),
    'routine-1:1234',
  )
})
