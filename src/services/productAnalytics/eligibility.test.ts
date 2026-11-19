import { expect, test } from 'bun:test'
import { hasCompletedResponse, hasHumanRequest } from './eligibility.js'
const user = (value: string, extra = {}) => ({ type: 'user', uuid: 'local-user-id', message: { content: value }, ...extra })
const assistant = (stop: string, text: string, extra = {}) => ({ type: 'assistant', message: { stop_reason: stop, content: [{ type: 'text', text }] }, ...extra })
test('only a real user request qualifies', () => {
  expect(hasHumanRequest([user('hello')])).toBe(true)
  expect(hasHumanRequest([user('automation', { isMeta: true })])).toBe(false)
  expect(hasHumanRequest([user('delegated', { isSidechain: true })])).toBe(false)
  expect(hasHumanRequest([user('<command-name>/help</command-name>')])).toBe(false)
  expect(hasHumanRequest([user('   ')])).toBe(false)
  expect(hasHumanRequest([{ type: 'user', uuid: 'id', message: { content: [{ type: 'image' }] } }])).toBe(true)
})
test('only complete nonempty assistant messages qualify', () => {
  expect(hasCompletedResponse(assistant('end_turn', 'answer'))).toBe(true)
  expect(hasCompletedResponse(assistant('stop_sequence', 'answer'))).toBe(true)
  expect(hasCompletedResponse(assistant('max_tokens', 'partial'))).toBe(false)
  expect(hasCompletedResponse(assistant('end_turn', ' '))).toBe(false)
  expect(hasCompletedResponse(assistant('end_turn', 'error', { isApiErrorMessage: true }))).toBe(false)
  expect(hasCompletedResponse(assistant('end_turn', 'error', { apiError: 'error' }))).toBe(false)
})
