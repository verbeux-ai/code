import { afterEach, expect, mock, test } from 'bun:test'
import axios from 'axios'

import { executeEffort } from './effort.js'
import {
  clearVerbooModelsCache,
  fetchVerbooModels,
} from '../../services/api/verbooModels.js'

const originalGet = axios.get

afterEach(() => {
  axios.get = originalGet
  clearVerbooModelsCache()
})

test('/effort rejects values outside the advertised reasoning values for the active model', async () => {
  axios.get = mock(async () => ({
    data: {
      data: [
        {
          id: 'verboo/reasoner',
          reasoning: {
            effort_levels: ['Fast', 'balanced', 'deep'],
            default_effort: 'balanced',
          },
        },
      ],
    },
  })) as typeof axios.get
  await fetchVerbooModels('access-token', { force: true })

  expect(executeEffort('high', 'verboo/reasoner')).toEqual({
    message:
      'Invalid reasoning level: high. Available for verboo/reasoner: Fast, balanced, deep, auto',
  })
})
