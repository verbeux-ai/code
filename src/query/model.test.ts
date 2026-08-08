import { describe, expect, test } from 'bun:test'
import { resolveQueryTurnModel } from './model.js'

describe('resolveQueryTurnModel', () => {
  test('prefers a skill model override to the persisted session model', () => {
    expect(
      resolveQueryTurnModel({
        permissionMode: 'default',
        turnModel: 'gpt-5.6-sol',
        sessionModel: 'max/deepseek-v4-pro',
      }),
    ).toBe('gpt-5.6-sol')
  })

  test('supports same-provider worker model overrides', () => {
    expect(
      resolveQueryTurnModel({
        permissionMode: 'default',
        turnModel: 'max/mimo-v2.5-pro',
        sessionModel: 'max/deepseek-v4-pro',
      }),
    ).toBe('max/mimo-v2.5-pro')
  })

  test('falls back to the persisted session model without a turn override', () => {
    expect(
      resolveQueryTurnModel({
        permissionMode: 'default',
        sessionModel: 'max/deepseek-v4-pro',
      }),
    ).toBe('max/deepseek-v4-pro')
  })

  test('falls back to the session model when a profile has no available candidate', () => {
    expect(
      resolveQueryTurnModel({
        permissionMode: 'default',
        turnModel: 'profile:review',
        sessionModel: 'max/deepseek-v4-pro',
      }),
    ).toBe('max/deepseek-v4-pro')
  })
})
