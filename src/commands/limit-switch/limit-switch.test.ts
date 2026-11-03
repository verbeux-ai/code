import { expect, test } from 'bun:test'

import { lastUserPromptText, limitSwitchModelOptions } from './limit-switch.js'

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

test('finds the last prompt the user typed, skipping meta and tool results', () => {
  const messages = [
    { type: 'user', message: { content: 'first request' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
    { type: 'user', message: { content: 'refactor the parser' } },
    { type: 'user', isMeta: true, message: { content: 'system reminder' } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'out' }] } },
    { type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'limit' }] } },
  ] as never
  expect(lastUserPromptText(messages)).toBe('refactor the parser')
  expect(lastUserPromptText([] as never)).toBeNull()
})
