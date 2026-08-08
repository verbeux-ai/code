import { beforeEach, expect, mock, test } from 'bun:test'

const models = [
  {
    id: 'gpt-codex-primary',
    displayName: 'Codex Primary',
    description: 'Primary model',
    supportedReasoningLevels: [],
    priority: 1,
  },
  {
    id: 'gpt-codex-hidden',
    displayName: 'Codex Hidden',
    description: 'Still returned by the account API',
    supportedReasoningLevels: [],
    visibility: 'hidden',
    supportedInApi: false,
    priority: 2,
  },
]
const verbooModels = [
  {
    id: 'verboo-default',
    displayName: 'Verboo Default',
    raw: {},
  },
]
const claudeModels = [
  {
    id: 'verboo-default',
    displayName: 'Duplicate Verboo ID',
    supportedReasoningLevels: [],
    raw: {},
  },
  {
    id: 'gpt-codex-primary',
    displayName: 'Duplicate Codex ID',
    supportedReasoningLevels: [],
    raw: {},
  },
  {
    id: 'claude-native-primary',
    displayName: 'Claude Native Primary',
    supportedReasoningLevels: [],
    raw: {},
  },
]

const fetchCodexModels = mock(async () => models)
const fetchClaudeNativeModels = mock(async () => claudeModels)
const assertCodexModelAvailable = mock(async (model: string) => {
  const match = models.find(candidate => candidate.id === model)
  if (!match) {
    throw new Error(
      `O modelo '${model}' não está disponível para esta conta Codex. Execute /model para escolher um modelo do catálogo atual.`,
    )
  }
  return match
})

mock.module('../../services/api/codexModels.js', () => ({
  assertCodexModelAvailable,
  clearCodexModelsCache: () => {},
  fetchCodexModels,
  getCachedCodexModels: () => models,
  getCodexModel: (model: string) =>
    models.find(candidate => candidate.id === model),
  getCodexReasoningEffort: () => undefined,
  getCodexReasoningLevels: () => [],
  parseCodexModelsResponse: () => models,
  requireCodexModel: assertCodexModelAvailable,
}))

mock.module('../../services/api/verbooModels.js', () => ({
  clearVerbooModelsCache: () => {},
  fetchVerbooModels: mock(async () => verbooModels),
  getCachedVerbooModels: () => verbooModels,
  getVerbooAgentModelForRole: () => undefined,
  getVerbooModelMeta: (modelId: string) =>
    verbooModels.find(model => model.id === modelId),
  getVerbooModelReasoning: () => undefined,
  getVerbooReasoningEffort: () => undefined,
}))

mock.module('../../services/api/claudeNativeModels.js', () => ({
  assertClaudeNativeModelAvailable: mock(async (model: string) => {
    const match = claudeModels.find(candidate => candidate.id === model)
    if (!match) throw new Error(`Unknown Claude model: ${model}`)
    return match
  }),
  clearClaudeNativeModelsCache: () => {},
  fetchClaudeNativeModels,
  getCachedClaudeNativeModels: () => claudeModels,
  getClaudeNativeModel: (model: string) =>
    claudeModels.find(candidate => candidate.id === model),
  getClaudeNativeReasoningEffort: () => undefined,
  parseClaudeNativeModelsResponse: () => ({
    models: claudeModels,
    hasMore: false,
  }),
  requireClaudeNativeModel: mock(async (model: string) => model),
}))

async function importFreshModelModule(
  suffix: string,
): Promise<typeof import('./model.js')> {
  return import(`./model.js?${suffix}`) as Promise<typeof import('./model.js')>
}

beforeEach(() => {
  fetchCodexModels.mockClear()
  fetchClaudeNativeModels.mockClear()
  assertCodexModelAvailable.mockClear()
})

test('/model rejects values absent from every unlocked catalog', async () => {
  const messages: string[] = []
  const setAppState = mock(() => {})
  const { call } = await importFreshModelModule('codex-reject-unknown')

  await call(
    message => {
      if (message) messages.push(message)
    },
    {
      getAppState: () => ({
        mainLoopModel: 'gpt-codex-primary',
        mainLoopModelForSession: null,
      }),
      setAppState,
    } as never,
    'arbitrary-model',
  )

  expect(setAppState).not.toHaveBeenCalled()
  expect(messages[0]).toContain("'arbitrary-model' não está disponível")
})

test('/model keeps Verboo first and adds deduplicated Codex then Claude models', async () => {
  const { call } = await importFreshModelModule('codex-all-api-models')
  const result = await call(() => {}, {} as never, '')

  expect(result).toBeTruthy()
  expect(
    (result as { props: { models: Array<{ id: string }> } }).props.models.map(
      model => model.id,
    ),
  ).toEqual([
    'verboo-default',
    'gpt-codex-primary',
    'gpt-codex-hidden',
    'claude-native-primary',
  ])
})

test('/model accepts an exact model ID unlocked by Claude', async () => {
  const messages: string[] = []
  let selectedModel: string | null = null
  const { call } = await importFreshModelModule('claude-exact-id')

  await call(
    message => {
      if (message) messages.push(message)
    },
    {
      getAppState: () => ({
        mainLoopModel: 'verboo-default',
        mainLoopModelForSession: null,
      }),
      setAppState: (
        update: (state: {
          mainLoopModel: string | null
          mainLoopModelForSession: string | null
        }) => {
          mainLoopModel: string | null
          mainLoopModelForSession: string | null
        },
      ) => {
        selectedModel = update({
          mainLoopModel: 'verboo-default',
          mainLoopModelForSession: null,
        }).mainLoopModel
      },
    } as never,
    'claude-native-primary',
  )

  expect(selectedModel).toBe('claude-native-primary')
  expect(messages[0]).toContain('claude-native-primary')
})

test('shouldAutoRefreshRouteCatalog preserves upstream discovery behavior', async () => {
  const { shouldAutoRefreshRouteCatalog } =
    await importFreshModelModule('descriptor-refresh-modes')

  expect(
    shouldAutoRefreshRouteCatalog({
      catalog: {
        source: 'dynamic',
        discovery: { kind: 'openai-compatible' },
        discoveryRefreshMode: 'manual',
      },
      hasCachedModels: true,
      staticEntryCount: 0,
      stale: true,
    }),
  ).toBe(false)
})
