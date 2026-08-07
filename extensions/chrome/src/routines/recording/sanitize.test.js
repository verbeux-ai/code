import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  isSensitiveField,
  recordedEventsToDraft,
  sanitizeRecordedEvent,
} from './sanitize.js'

test('detects password, payment, and secret fields', () => {
  assert.equal(isSensitiveField({ type: 'password' }), true)
  assert.equal(isSensitiveField({ autocomplete: 'cc-number' }), true)
  assert.equal(isSensitiveField({ name: 'api_token' }), true)
  assert.equal(isSensitiveField({ type: 'text', name: 'company' }), false)
})

test('drops sensitive input and marks safe values unresolved', () => {
  assert.equal(
    sanitizeRecordedEvent({
      kind: 'input',
      field: { type: 'password', name: 'password' },
      value: 'secret',
    }),
    null,
  )
  assert.deepEqual(
    sanitizeRecordedEvent({
      kind: 'input',
      url: 'https://example.com',
      selectorCandidates: ['input[name="company"]'],
      field: { type: 'text', name: 'company' },
      value: 'Acme',
      timestamp: 10,
    }),
    {
      kind: 'input',
      url: 'https://example.com/',
      selectorCandidates: ['input[name="company"]'],
      field: { type: 'text', name: 'company', autocomplete: '', label: '' },
      valueMode: 'unresolved',
      ephemeralValue: 'Acme',
      timestamp: 10,
    },
  )
})

test('turns safe events into an editable hybrid routine draft', () => {
  const draft = recordedEventsToDraft([
    {
      kind: 'click',
      url: 'https://example.com/',
      selectorCandidates: ['#open'],
      accessibleName: 'Open',
      timestamp: 1,
    },
    {
      kind: 'input',
      url: 'https://example.com/',
      selectorCandidates: ['input[name="company"]'],
      field: { name: 'company', label: 'Company' },
      valueMode: 'unresolved',
      ephemeralValue: 'Acme',
      timestamp: 2,
    },
  ])

  assert.equal(draft.recordedSteps.length, 2)
  assert.equal(draft.recordedSteps[1].params.text, '{{company}}')
  assert.match(draft.instructions, /\{\{company\}\}/)
  assert.doesNotMatch(JSON.stringify(draft), /Acme/)
})
