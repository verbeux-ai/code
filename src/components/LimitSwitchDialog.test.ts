import { expect, test } from 'bun:test'

import { describeFailedTurn, limitSwitchDoneMessage, limitSwitchModelOptions } from './LimitSwitchDialog.js'

test('offers Verboo models, last used first, plus keeping the current one', () => {
  const options = limitSwitchModelOptions(
    [
      { id: 'ultra/a', displayName: 'A' },
      { id: 'ultra/b', displayName: 'B' },
      { id: 'ultra/c' },
    ],
    'ultra/b',
  )
  expect(options.map(option => option.value)).toEqual([
    'ultra/b',
    'ultra/a',
    'ultra/c',
    '__keep_current_model__',
  ])
  expect(options[2]?.label).toBe('ultra/c')
})

test('caps the list at five models', () => {
  const models = Array.from({ length: 8 }, (_, i) => ({ id: `m${i}` }))
  expect(limitSwitchModelOptions(models, undefined)).toHaveLength(6)
})

const limitError = { type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'limit' }] } }
const reply = { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }

test('a turn where nothing ran can be sent again', () => {
  const turn = describeFailedTurn([
    { type: 'user', uuid: 'old', message: { content: 'first request' } },
    reply,
    { type: 'user', uuid: 'new', message: { content: 'refactor the parser' } },
    { type: 'user', isMeta: true, message: { content: 'system reminder' } },
    limitError,
  ] as never)
  expect(turn).toEqual({ prompt: 'refactor the parser', promptUuid: 'new', toolsRan: false })
  expect(describeFailedTurn([] as never)).toEqual({ prompt: null, toolsRan: false })
})

test('a turn that already ran tools is reported, so it is not repeated', () => {
  const turn = describeFailedTurn([
    { type: 'user', uuid: 'new', message: { content: 'append to the file' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'out' }] } },
    limitError,
  ] as never)
  expect(turn.toolsRan).toBe(true)
  expect(limitSwitchDoneMessage('m', turn)).toContain('nada foi reenviado')
})

test('the compaction summary is not mistaken for what the user typed', () => {
  const turn = describeFailedTurn([
    { type: 'user', uuid: 'typed', message: { content: 'next step' } },
    { type: 'system', subtype: 'compact_boundary' },
    { type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { content: 'This session is being continued' } },
    limitError,
  ] as never)
  expect(turn.prompt).toBe('next step')
})

test('a turn not started by typed text never falls back to an older prompt', () => {
  for (const content of [
    [{ type: 'image', source: {} }, { type: 'text', text: 'see this' }],
    '<local-command-stdout>done</local-command-stdout>',
    '<task-notification>agent finished</task-notification>',
  ]) {
    const turn = describeFailedTurn([
      { type: 'user', uuid: 'old', message: { content: 'older prompt' } },
      reply,
      { type: 'user', uuid: 'new', message: { content } },
      limitError,
    ] as never)
    expect(turn.prompt).toBeNull()
  }
})
