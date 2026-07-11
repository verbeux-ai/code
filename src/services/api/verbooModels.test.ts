import { afterEach, expect, mock, test } from 'bun:test'
import axios from 'axios'

import {
  clearVerbooModelsCache,
  fetchVerbooModels,
  getVerbooModelReasoning,
  getVerbooReasoningEffort,
} from './verbooModels.js'
import {
  getEffortSuffix,
  resolveAppliedEffort,
  toPersistableEffort,
} from '../../utils/effort.js'

const originalGet = axios.get
const originalEffortLevel = process.env.CLAUDE_CODE_EFFORT_LEVEL

afterEach(() => {
  axios.get = originalGet
  clearVerbooModelsCache()
  if (originalEffortLevel === undefined) {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
  } else {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = originalEffortLevel
  }
})

test('uses the router reasoning contract as the model capability source', async () => {
  delete process.env.CLAUDE_CODE_EFFORT_LEVEL
  const get = mock(async () => ({
    data: {
      data: [
        {
          id: 'verboo/reasoner',
          reasoning: {
            effort_levels: ['Fast', 'balanced', 'deep'],
            default_effort: 'BALANCED',
          },
        },
      ],
    },
  }))
  axios.get = get as typeof axios.get

  await expect(fetchVerbooModels('access-token', { force: true })).resolves.toEqual([
    expect.objectContaining({
      id: 'verboo/reasoner',
      reasoning: {
        effortLevels: ['Fast', 'balanced', 'deep'],
        defaultEffort: 'balanced',
      },
    }),
  ])
  expect(getVerbooModelReasoning('verboo/reasoner')).toEqual({
    effortLevels: ['Fast', 'balanced', 'deep'],
    defaultEffort: 'balanced',
  })
  expect(getVerbooReasoningEffort('verboo/reasoner', 'FAST')).toBe('Fast')
  expect(getVerbooReasoningEffort('verboo/reasoner', 'unknown')).toBeUndefined()
  expect(toPersistableEffort('Fast')).toBe('Fast')
  expect(resolveAppliedEffort('verboo/reasoner', undefined)).toBeUndefined()
  expect(resolveAppliedEffort('verboo/reasoner', 'deep')).toBe('deep')
  expect(getEffortSuffix('verboo/reasoner', undefined)).toBe(
    ' with balanced effort',
  )
  expect(getEffortSuffix('verboo/reasoner', 'deep')).toBe(' with deep effort')
})

test('does not advertise reasoning when the router response is incomplete', async () => {
  axios.get = mock(async () => ({
    data: {
      data: [
        {
          id: 'verboo/no-reasoning',
          reasoning: { effort_levels: ['low', 'high'], default_effort: 'medium' },
        },
      ],
    },
  })) as typeof axios.get

  await fetchVerbooModels('access-token', { force: true })

  expect(getVerbooModelReasoning('verboo/no-reasoning')).toBeUndefined()
})
