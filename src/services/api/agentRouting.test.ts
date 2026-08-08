import { afterEach, describe, expect, mock, test } from 'bun:test'
import axios from 'axios'
import {
  resolveAgentExecutionModel,
  resolveAgentProvider,
  resolveAgentRoute,
} from './agentRouting.js'
import {
  clearVerbooModelsCache,
  fetchVerbooModels,
} from './verbooModels.js'
import {
  SettingsSchema,
  type SettingsJson,
} from '../../utils/settings/types.js'
import type { VerbooModel } from './verbooModels.js'

const models = (...ids: string[]): VerbooModel[] =>
  ids.map(id => ({ id, raw: { id } }))

const baseSettings = {
  agentModels: {
    'deepseek-chat': { base_url: 'https://api.deepseek.com/v1', api_key: 'sk-ds' },
    'gpt-4o': { base_url: 'https://api.openai.com/v1', api_key: 'sk-oai' },
  },
  agentRouting: {
    Explore: 'deepseek-chat',
    'general-purpose': 'gpt-4o',
    'frontend-dev': 'deepseek-chat',
    default: 'gpt-4o',
  },
} as unknown as SettingsJson

const originalGet = axios.get
const originalSubagentModel = process.env.CLAUDE_CODE_SUBAGENT_MODEL

afterEach(() => {
  axios.get = originalGet
  clearVerbooModelsCache()
  if (originalSubagentModel === undefined) {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  } else {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = originalSubagentModel
  }
})

describe('resolveAgentProvider', () => {
  // ── Priority chain ──────────────────────────────────────────

  test('name takes priority over subagentType', () => {
    const result = resolveAgentProvider('frontend-dev', 'Explore', baseSettings)
    expect(result).toEqual({
      model: 'deepseek-chat',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'sk-ds',
    })
  })

  test('subagentType used when name has no match', () => {
    const result = resolveAgentProvider('unknown-name', 'Explore', baseSettings)
    expect(result).toEqual({
      model: 'deepseek-chat',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'sk-ds',
    })
  })

  test('falls back to "default" when neither name nor subagentType match', () => {
    const result = resolveAgentProvider('nobody', 'unknown-type', baseSettings)
    expect(result).toEqual({
      model: 'gpt-4o',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-oai',
    })
  })

  test('returns null when no routing match and no default', () => {
    const settings = {
      agentModels: baseSettings.agentModels,
      agentRouting: { Explore: 'deepseek-chat' },
    } as unknown as SettingsJson
    const result = resolveAgentProvider('nobody', 'unknown-type', settings)
    expect(result).toBeNull()
  })

  test('returns null when name and subagentType are both undefined', () => {
    const settings = {
      agentModels: baseSettings.agentModels,
      agentRouting: { Explore: 'deepseek-chat' },
    } as unknown as SettingsJson
    const result = resolveAgentProvider(undefined, undefined, settings)
    expect(result).toBeNull()
  })

  // ── normalize() matching ────────────────────────────────────

  test('matching is case-insensitive', () => {
    const result = resolveAgentProvider(undefined, 'explore', baseSettings)
    expect(result?.model).toBe('deepseek-chat')
  })

  test('matching is case-insensitive (UPPER)', () => {
    const result = resolveAgentProvider(undefined, 'EXPLORE', baseSettings)
    expect(result?.model).toBe('deepseek-chat')
  })

  test('hyphen and underscore are equivalent', () => {
    const result = resolveAgentProvider(undefined, 'general_purpose', baseSettings)
    expect(result?.model).toBe('gpt-4o')
  })

  test('underscore in config matches hyphen in input', () => {
    const settings = {
      agentModels: baseSettings.agentModels,
      agentRouting: { general_purpose: 'deepseek-chat' },
    } as unknown as SettingsJson
    const result = resolveAgentProvider(undefined, 'general-purpose', settings)
    expect(result?.model).toBe('deepseek-chat')
  })

  // ── Edge cases ──────────────────────────────────────────────

  test('returns null when settings is null', () => {
    expect(resolveAgentProvider('Explore', 'Explore', null)).toBeNull()
  })

  test('returns null when agentRouting is missing', () => {
    const settings = { agentModels: baseSettings.agentModels } as unknown as SettingsJson
    expect(resolveAgentProvider(undefined, 'Explore', settings)).toBeNull()
  })

  test('returns null when agentModels is missing', () => {
    const settings = { agentRouting: baseSettings.agentRouting } as unknown as SettingsJson
    expect(resolveAgentProvider(undefined, 'Explore', settings)).toBeNull()
  })

  test('returns null when routing references non-existent model', () => {
    const settings = {
      agentModels: {},
      agentRouting: { Explore: 'non-existent-model' },
    } as unknown as SettingsJson
    expect(resolveAgentProvider(undefined, 'Explore', settings)).toBeNull()
  })

  test('subagentType only (no name)', () => {
    const result = resolveAgentProvider(undefined, 'Explore', baseSettings)
    expect(result?.model).toBe('deepseek-chat')
  })

  test('name only (no subagentType)', () => {
    const result = resolveAgentProvider('frontend-dev', undefined, baseSettings)
    expect(result?.model).toBe('deepseek-chat')
  })
})

describe('resolveAgentExecutionModel', () => {
  test('maps Explore haiku to the authenticated catalog role', async () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
    axios.get = mock(async () => ({
      data: {
        data: [{ id: 'xiaomi/mimo-v2-flash' }, { id: 'gpt-5.6-sol' }],
        agent_model_roles: { explore: 'xiaomi/mimo-v2-flash' },
      },
    })) as typeof axios.get
    await fetchVerbooModels('token', { force: true })

    expect(
      resolveAgentExecutionModel({
        agentModel: 'haiku',
        agentModelRole: 'explore',
        parentModel: 'gpt-5.6-sol',
        toolSpecifiedModel: 'haiku',
        permissionMode: 'default',
        agentType: 'Explore',
        settings: null,
      }),
    ).toEqual({
      effectiveModel: 'xiaomi/mimo-v2-flash',
      requestedModel: 'haiku',
      source: 'catalog_role',
      providerOverride: null,
      catalogRole: 'explore',
    })
  })

  test('inherits the parent with an explicit reason when the role is missing', () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
    expect(
      resolveAgentExecutionModel({
        agentModel: 'haiku',
        agentModelRole: 'explore',
        parentModel: 'gpt-5.6-sol',
        permissionMode: 'default',
        agentType: 'Explore',
        settings: null,
      }),
    ).toEqual({
      effectiveModel: 'gpt-5.6-sol',
      requestedModel: 'haiku',
      source: 'parent_fallback',
      providerOverride: null,
      catalogRole: 'explore',
      fallbackReason: 'missing_catalog_role',
    })
  })

  test('preserves legacy external provider routing precedence', () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
    const result = resolveAgentExecutionModel({
      agentModel: 'haiku',
      agentModelRole: 'explore',
      parentModel: 'gpt-5.6-sol',
      permissionMode: 'default',
      agentType: 'Explore',
      settings: baseSettings,
    })
    expect(result.source).toBe('external_route')
    expect(result.effectiveModel).toBe('deepseek-chat')
    expect(result.providerOverride?.baseURL).toBe('https://api.deepseek.com/v1')
  })

  test('protects non-opted agents from unsupported provider aliases without catalog remapping', () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
    expect(
      resolveAgentExecutionModel({
        agentModel: 'haiku',
        parentModel: 'gpt-5.6-sol',
        permissionMode: 'default',
        agentType: 'claude-code-guide',
        settings: null,
      }),
    ).toEqual({
      effectiveModel: 'gpt-5.6-sol',
      requestedModel: 'haiku',
      source: 'parent_fallback',
      providerOverride: null,
      fallbackReason: 'unsupported_provider_alias',
    })
  })
})

describe('catalog-aware profiles from PR 18', () => {
  test('prefers a router-advertised profile role over client compatibility candidates', async () => {
    axios.get = mock(async () => ({
      data: {
        data: [{ id: 'router/reviewer' }, { id: 'max/deepseek-v4-pro' }],
        agent_model_roles: { review: 'router/reviewer' },
      },
    })) as typeof axios.get
    const catalog = await fetchVerbooModels('token', { force: true })

    expect(
      resolveAgentRoute(
        undefined,
        'worker-review',
        {
          agentRouting: { 'worker-review': { profile: 'review' } },
        } as SettingsJson,
        catalog,
      ),
    ).toEqual({
      model: 'router/reviewer',
      source: 'profile',
      profile: 'review',
    })
  })

  test('preserves a plan-qualified canonical ID selected by a profile', () => {
    const settings = {
      agentRouting: { 'worker-review': { profile: 'review' } },
    } as SettingsJson

    expect(
      resolveAgentRoute(
        undefined,
        'worker-review',
        settings,
        models('max/qwen3.6-27b', 'max/deepseek-v4-pro'),
      ),
    ).toEqual({
      model: 'max/deepseek-v4-pro',
      source: 'profile',
      profile: 'review',
    })
  })

  test('matches an unqualified exact model to its authenticated canonical ID', () => {
    const settings = {
      agentRouting: {
        'worker-tests': {
          model: 'qwen3.6-27b',
          provider: 'inherit',
        },
      },
    } as SettingsJson

    expect(
      resolveAgentRoute(
        undefined,
        'worker-tests',
        settings,
        models('max/qwen3.6-27b'),
      ),
    ).toEqual({
      model: 'max/qwen3.6-27b',
      source: 'verboo-model',
    })
  })

  test('uses a fast catalog profile when the router has not advertised Explore role metadata yet', async () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
    axios.get = mock(async () => ({
      data: {
        data: [{ id: 'max/deepseek-v4-flash' }, { id: 'gpt-5.6-sol' }],
      },
    })) as typeof axios.get
    await fetchVerbooModels('token', { force: true })

    expect(
      resolveAgentExecutionModel({
        agentModel: 'haiku',
        agentModelRole: 'explore',
        parentModel: 'gpt-5.6-sol',
        permissionMode: 'default',
        agentType: 'Explore',
        settings: null,
      }),
    ).toEqual({
      effectiveModel: 'max/deepseek-v4-flash',
      requestedModel: 'haiku',
      source: 'catalog_profile',
      providerOverride: null,
      catalogRole: 'explore',
      profile: 'fast',
    })
  })

  test('resolves profile references used by forked skills', async () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
    axios.get = mock(async () => ({
      data: {
        data: [{ id: 'max/qwen3.6-27b' }, { id: 'gpt-5.6-sol' }],
      },
    })) as typeof axios.get
    await fetchVerbooModels('token', { force: true })

    expect(
      resolveAgentExecutionModel({
        agentModel: 'profile:testing',
        parentModel: 'gpt-5.6-sol',
        permissionMode: 'default',
        agentType: 'worker-tests',
        settings: null,
      }),
    ).toEqual({
      effectiveModel: 'max/qwen3.6-27b',
      requestedModel: 'profile:testing',
      source: 'catalog_profile',
      providerOverride: null,
      profile: 'testing',
    })
  })

  test('settings schema accepts profiles and inherited exact models', () => {
    expect(
      SettingsSchema().safeParse({
        agentRouting: {
          Explore: 'fast',
          review: { profile: 'review' },
          tests: { model: 'max/qwen3.6-27b', provider: 'inherit' },
        },
      }).success,
    ).toBe(true)

    expect(
      SettingsSchema().safeParse({
        agentRouting: { review: { profile: 'unknown' } },
      }).success,
    ).toBe(false)
  })

  test('new profile routes inherit safely when the catalog has no candidate', () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
    expect(
      resolveAgentExecutionModel({
        agentModel: 'haiku',
        parentModel: 'gpt-5.6-sol',
        permissionMode: 'default',
        agentType: 'worker-review',
        settings: {
          agentRouting: {
            'worker-review': { profile: 'review' },
          },
        } as SettingsJson,
      }),
    ).toEqual({
      effectiveModel: 'gpt-5.6-sol',
      requestedModel: 'profile:review',
      source: 'parent_fallback',
      providerOverride: null,
      profile: 'review',
      fallbackReason: 'missing_catalog_profile',
    })
  })
})
