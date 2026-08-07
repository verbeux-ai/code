import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildConversationDraft, buildPromptDraft } from './draftBuilder.js'

test('builds a deterministic draft from one prompt', () => {
  const draft = buildPromptDraft(
    'Compare {{empresa}} com os concorrentes.',
    { url: 'https://example.com/dashboard' },
  )

  assert.equal(draft.command, 'compare-empresa-com-os-concorrentes')
  assert.deepEqual(draft.variables.map((item) => item.name), ['empresa'])
  assert.deepEqual(draft.allowedOrigins, ['https://example.com'])
})

test('accepts only approved model-draft fields', () => {
  const draft = buildConversationDraft(
    [{ role: 'user', content: 'Open the dashboard.' }],
    JSON.stringify({
      name: 'Dashboard',
      command: 'dashboard',
      instructions: 'Open it.',
      description: 'Daily view',
      startUrl: 'https://example.com',
      allowedOrigins: ['https://example.com'],
      accountId: 'attacker',
      recordedSteps: [{ name: 'click' }],
    }),
  )

  assert.equal(draft.name, 'Dashboard')
  assert.equal(draft.accountId, undefined)
  assert.equal(draft.recordedSteps, undefined)
})

test('invalid model JSON falls back to user messages without assistant text', () => {
  const draft = buildConversationDraft(
    [
      { role: 'user', content: 'Open the dashboard.' },
      { role: 'assistant', content: 'A secret assistant-only suggestion.' },
      { role: 'user', content: 'Then summarize the metrics.' },
    ],
    '{not-json',
  )

  assert.match(draft.instructions, /Open the dashboard/)
  assert.match(draft.instructions, /summarize the metrics/)
  assert.doesNotMatch(draft.instructions, /assistant-only/)
})
