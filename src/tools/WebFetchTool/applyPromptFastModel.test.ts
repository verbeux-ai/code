import { afterEach, expect, mock, test } from 'bun:test'
import axios from 'axios'

const actualOauth = { ...(await import('../../constants/oauth.js')) }
mock.module('../../constants/oauth.js', () => ({
  ...actualOauth,
  isVerbooMode: () => true,
}))

const queryHaiku = mock(async (): Promise<unknown> => ({ message: { content: [] } }))
const queryWithModel = mock(
  async (_args: { options: { model: string } }): Promise<unknown> => ({
    message: { content: [{ type: 'text', text: 'Summary from the fast model.' }] },
  }),
)
const actualClaude = { ...(await import('../../services/api/claude.js')) }
mock.module('../../services/api/claude.js', () => ({
  ...actualClaude,
  queryHaiku,
  queryWithModel,
}))

const { applyPromptToMarkdown } = await import('./utils.js')
const { clearVerbooModelsCache, fetchVerbooModels } = await import(
  '../../services/api/verbooModels.js'
)

const originalGet = axios.get

afterEach(() => {
  axios.get = originalGet
  clearVerbooModelsCache()
})

test('summarizes with the router "fast" role model when advertised', async () => {
  axios.get = mock(async () => ({
    data: {
      data: [{ id: 'ultra/glm-5.3' }, { id: 'ultra/glm-5.3-flash-cheap' }],
      agent_model_roles: { fast: 'ultra/glm-5.3-flash-cheap' },
    },
  })) as typeof axios.get
  await fetchVerbooModels('access-token', { force: true })

  const output = await applyPromptToMarkdown(
    'summarize',
    'page content',
    new AbortController().signal,
    false,
    false,
  )

  expect(output).toBe('Summary from the fast model.')
  expect(queryHaiku).not.toHaveBeenCalled()
  expect(queryWithModel.mock.calls[0]![0].options.model).toBe(
    'ultra/glm-5.3-flash-cheap',
  )
})
