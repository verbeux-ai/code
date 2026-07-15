import { afterEach, expect, mock, test } from 'bun:test'
import axios from 'axios'

import { clearVerbooModelsCache } from '../api/verbooModels.js'
import { checkVerbooModels } from './verbooStartupAuth.js'

const originalGet = axios.get

afterEach(() => {
  axios.get = originalGet
  clearVerbooModelsCache()
})

test('classifies a model timeout as unavailable rather than an empty account', async () => {
  axios.get = mock(async () => {
    throw new Error('timeout of 10000ms exceeded')
  }) as typeof axios.get

  await expect(checkVerbooModels('access-token')).resolves.toEqual({
    kind: 'unavailable',
    reason: 'timeout of 10000ms exceeded',
    models: [],
  })
})
