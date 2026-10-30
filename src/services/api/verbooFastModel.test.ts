import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import axios from 'axios'

const actualOauth = { ...(await import('../../constants/oauth.js')) }
let verbooMode = true
mock.module('../../constants/oauth.js', () => ({
  ...actualOauth,
  isVerbooMode: () => verbooMode,
}))

const queryHaiku = mock(async () => ({ message: { content: [] } }))
const queryWithModel = mock(async () => ({ message: { content: [] } }))
const actualClaude = { ...(await import('./claude.js')) }
mock.module('./claude.js', () => ({ ...actualClaude, queryHaiku, queryWithModel }))

let codexModels: Array<{ id: string }> | null = null
const actualCodex = { ...(await import('./codexModels.js')) }
mock.module('./codexModels.js', () => ({
  ...actualCodex,
  getCachedCodexModels: () => codexModels,
}))

const {
  getVerbooFastRoleModel,
  queryFastModel,
  sideQuerySupportsStructuredOutput,
} = await import('./verbooFastModel.js')
const { clearVerbooModelsCache, fetchVerbooModels } = await import('./verbooModels.js')

const originalGet = axios.get

async function seedCatalog(roles?: Record<string, string>): Promise<void> {
  axios.get = mock(async () => ({
    data: {
      data: [{ id: 'ultra/glm-5.3' }, { id: 'ultra/glm-5.3-flash-cheap' }],
      agent_model_roles: roles,
    },
  })) as typeof axios.get
  await fetchVerbooModels('access-token', { force: true })
}

const args = {
  systemPrompt: [] as never,
  userPrompt: 'hello',
  signal: new AbortController().signal,
  options: {
    querySource: 'generate_session_title' as const,
    agents: [],
    isNonInteractiveSession: false,
    hasAppendSystemPrompt: false,
    mcpTools: [],
  },
}

beforeEach(() => {
  verbooMode = true
  codexModels = null
  queryHaiku.mockClear()
  queryWithModel.mockClear()
})

afterEach(() => {
  axios.get = originalGet
  clearVerbooModelsCache()
})

describe('queryFastModel', () => {
  test('uses the router "fast" role model when advertised', async () => {
    await seedCatalog({ fast: 'ultra/glm-5.3-flash-cheap' })
    expect(getVerbooFastRoleModel()).toBe('ultra/glm-5.3-flash-cheap')
    await queryFastModel(args)
    expect(queryHaiku).not.toHaveBeenCalled()
    expect(queryWithModel).toHaveBeenCalledTimes(1)
    const call = queryWithModel.mock.calls[0] as unknown as [
      { options: { model: string } },
    ]
    expect(call[0].options.model).toBe('ultra/glm-5.3-flash-cheap')
  })

  test('keeps the previous small-fast model when no role is advertised', async () => {
    await seedCatalog({})
    expect(getVerbooFastRoleModel()).toBeUndefined()
    await queryFastModel(args)
    expect(queryWithModel).not.toHaveBeenCalled()
    expect(queryHaiku).toHaveBeenCalledTimes(1)
  })

  test('ignores roles outside Verboo mode', async () => {
    await seedCatalog({ fast: 'ultra/glm-5.3-flash-cheap' })
    verbooMode = false
    expect(getVerbooFastRoleModel()).toBeUndefined()
  })
})

describe('sideQuerySupportsStructuredOutput', () => {
  test('router models never get output_format (403 structured_output_not_enabled)', async () => {
    await seedCatalog({})
    expect(sideQuerySupportsStructuredOutput('ultra/glm-5.3')).toBe(false)
  })

  test('unknown models are treated as router models', () => {
    expect(sideQuerySupportsStructuredOutput('who-knows')).toBe(false)
  })

  test('Codex models keep structured output', () => {
    codexModels = [{ id: 'gpt-5.5' }]
    expect(sideQuerySupportsStructuredOutput('gpt-5.5')).toBe(true)
  })

  test('the router catalog wins when a Codex model shares the id', async () => {
    await seedCatalog({})
    codexModels = [{ id: 'ultra/glm-5.3' }]
    expect(sideQuerySupportsStructuredOutput('ultra/glm-5.3')).toBe(false)
  })

  test('outside Verboo mode nothing changes', () => {
    verbooMode = false
    expect(sideQuerySupportsStructuredOutput('anything')).toBe(true)
  })
})
