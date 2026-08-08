import { afterEach, describe, expect, mock, test } from 'bun:test'
import axios from 'axios'
import { resolveQueryTurnModel } from './model.js'
import {
  clearVerbooModelsCache,
  fetchVerbooModels,
} from '../services/api/verbooModels.js'

const originalGet = axios.get

afterEach(() => {
  axios.get = originalGet
  clearVerbooModelsCache()
})

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

  test('resolves an inline skill profile and preserves its qualified catalog ID', async () => {
    axios.get = mock(async () => ({
      data: {
        data: [{ id: 'max/deepseek-v4-pro' }, { id: 'gpt-5.6-sol' }],
      },
    })) as typeof axios.get
    await fetchVerbooModels('token', { force: true })

    expect(
      resolveQueryTurnModel({
        permissionMode: 'default',
        turnModel: 'profile:review',
        sessionModel: 'gpt-5.6-sol',
      }),
    ).toBe('max/deepseek-v4-pro')
  })

  test('inherits the session model when an inline profile is unavailable', () => {
    expect(
      resolveQueryTurnModel({
        permissionMode: 'default',
        turnModel: 'profile:review',
        sessionModel: 'gpt-5.6-sol',
      }),
    ).toBe('gpt-5.6-sol')
  })
})
