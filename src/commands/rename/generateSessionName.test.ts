import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import axios from 'axios'

const actualOauth = { ...(await import('../../constants/oauth.js')) }
mock.module('../../constants/oauth.js', () => ({
  ...actualOauth,
  isVerbooMode: () => true,
}))

type QueryArgs = { outputFormat?: unknown; options: { model?: string } }
const reply = (text: string) => ({ message: { content: [{ type: 'text', text }] } })
const queryHaiku = mock(async (_args: QueryArgs): Promise<unknown> => reply(''))
const queryWithModel = mock(async (_args: QueryArgs): Promise<unknown> => reply(''))
const actualClaude = { ...(await import('../../services/api/claude.js')) }
mock.module('../../services/api/claude.js', () => ({
  ...actualClaude,
  queryHaiku,
  queryWithModel,
}))

const { generateSessionName, generateSessionNameResult, parseSessionNameResponse } =
  await import('./generateSessionName.js')
const { createUserMessage } = await import('../../utils/messages.js')
const { clearVerbooModelsCache, fetchVerbooModels } = await import(
  '../../services/api/verbooModels.js'
)

const originalGet = axios.get
const signal = () => new AbortController().signal
const conversation = [createUserMessage({ content: 'please fix the login bug' })]

beforeEach(async () => {
  queryHaiku.mockReset()
  queryWithModel.mockReset()
  axios.get = mock(async () => ({
    data: {
      data: [{ id: 'ultra/glm-5.3' }, { id: 'ultra/glm-5.3-flash-cheap' }],
      agent_model_roles: { fast: 'ultra/glm-5.3-flash-cheap' },
    },
  })) as typeof axios.get
  await fetchVerbooModels('access-token', { force: true })
})

afterEach(() => {
  axios.get = originalGet
  clearVerbooModelsCache()
})

describe('parseSessionNameResponse', () => {
  test.each([
    ['{"name": "fix-login-bug"}', 'fix-login-bug'],
    ['fix-login-bug', 'fix-login-bug'],
    ['`fix-login-bug`', 'fix-login-bug'],
    ['Name: Fix Login Bug', 'fix-login-bug'],
    ['Here you go:\n"corrigir-autenticação"', 'corrigir-autenticação'],
    ['{"name":"add auth feature"} hope this helps', 'add-auth-feature'],
  ])('%j -> %j', (input, expected) => {
    expect(parseSessionNameResponse(input)).toBe(expected)
  })

  test('returns null for empty replies', () => {
    expect(parseSessionNameResponse('')).toBeNull()
    expect(parseSessionNameResponse('---')).toBeNull()
  })
})

describe('generateSessionNameResult in Verboo mode', () => {
  test('asks the fast model for plain text (no output_format)', async () => {
    queryWithModel.mockImplementation(async () => reply('fix-login-bug'))
    expect(await generateSessionNameResult(conversation, signal())).toEqual({
      ok: true,
      name: 'fix-login-bug',
    })
    const args = queryWithModel.mock.calls[0]![0]
    expect(args.outputFormat).toBeUndefined()
    expect(args.options.model).toBe('ultra/glm-5.3-flash-cheap')
  })

  test('reports a failed model call separately from "no context"', async () => {
    queryWithModel.mockImplementation(async () => {
      throw new Error('403 structured_output_not_enabled')
    })
    expect(await generateSessionNameResult(conversation, signal())).toEqual({
      ok: false,
      reason: 'failed',
    })
    expect(await generateSessionNameResult([], signal())).toEqual({
      ok: false,
      reason: 'no_context',
    })
    expect(await generateSessionName(conversation, signal())).toBeNull()
  })
})
