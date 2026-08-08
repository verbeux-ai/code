import { describe, expect, test } from 'bun:test'
import {
  parseAgentModelProfileReference,
  resolveAgentProfileModel,
  resolveAgentProvider,
  resolveAgentRoute,
} from './agentRouting.js'
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

describe('resolveAgentRoute profiles', () => {
  const proCatalog = models(
    'pro/qwen3.6-27b',
    'pro/deepseek-v4-flash',
    'pro/mimo-v2.5',
    'pro/glm-4.7-flash',
  )
  const maxCatalog = [
    ...proCatalog,
    ...models(
      'max/minimax-m3',
      'max/deepseek-v4-pro',
      'max/mimo-v2.5-pro',
    ),
  ]
  const ultraCatalog = [
    ...maxCatalog,
    ...models('ultra/kimi-k2.7', 'ultra/glm-5.2'),
  ]

  test('parses skill model profile references', () => {
    expect(parseAgentModelProfileReference('profile:review')).toBe('review')
    expect(parseAgentModelProfileReference('PROFILE:FAST')).toBe('fast')
    expect(parseAgentModelProfileReference('fast')).toBeNull()
    expect(parseAgentModelProfileReference('unknown-model')).toBeNull()
  })

  test('resolves a skill profile against the authenticated catalog', () => {
    expect(resolveAgentProfileModel('review', proCatalog)).toBe(
      'pro/qwen3.6-27b',
    )
    expect(resolveAgentProfileModel('review', maxCatalog)).toBe(
      'max/deepseek-v4-pro',
    )
  })

  test('testing profile preserves the plan-qualified Qwen model ID', () => {
    expect(
      resolveAgentProfileModel(
        'testing',
        models('max/mimo-v2.5', 'max/qwen3.6-27b'),
      ),
    ).toBe('max/qwen3.6-27b')
  })

  test('routes built-in Explore to fast by default in Verboo mode', () => {
    const settings = {} as SettingsJson

    expect(
      resolveAgentRoute(undefined, 'Explore', settings, proCatalog),
    ).toEqual({
      model: 'pro/deepseek-v4-flash',
      source: 'profile',
      profile: 'fast',
    })
  })

  test.each([
    ['Pro', proCatalog, 'pro/deepseek-v4-flash'],
    ['Max', maxCatalog, 'pro/deepseek-v4-flash'],
    ['Ultra', ultraCatalog, 'pro/deepseek-v4-flash'],
  ])('selects a fast model from the %s catalog', (_plan, catalog, expected) => {
    const settings = {
      agentRouting: { Explore: 'fast' },
    } as SettingsJson

    expect(resolveAgentRoute(undefined, 'Explore', settings, catalog)).toEqual({
      model: expected,
      source: 'profile',
      profile: 'fast',
    })
  })

  test.each([
    ['Pro', proCatalog, 'pro/qwen3.6-27b'],
    ['Max', maxCatalog, 'max/deepseek-v4-pro'],
    ['Ultra', ultraCatalog, 'max/deepseek-v4-pro'],
  ])(
    'selects the best available review model from the %s catalog',
    (_plan, catalog, expected) => {
      const settings = {
        agentRouting: { 'worker-review': { profile: 'review' } },
      } as SettingsJson

      expect(
        resolveAgentRoute(
          undefined,
          'worker-review',
          settings,
          catalog,
        ),
      ).toEqual({
        model: expected,
        source: 'profile',
        profile: 'review',
      })
    },
  )

  test('preserves the exact canonical ID returned by the catalog', () => {
    const settings = {
      agentRouting: {
        Explore: { model: 'deepseek-v4-flash', provider: 'inherit' },
      },
    } as SettingsJson

    expect(
      resolveAgentRoute(undefined, 'Explore', settings, proCatalog),
    ).toEqual({
      model: 'pro/deepseek-v4-flash',
      source: 'verboo-model',
    })
  })

  test('inherits when an explicit model is unavailable', () => {
    const settings = {
      agentRouting: {
        Explore: { model: 'deepseek-v4-pro', provider: 'inherit' },
      },
    } as SettingsJson

    expect(
      resolveAgentRoute(undefined, 'Explore', settings, proCatalog),
    ).toBeNull()
  })

  test('can opt into the first available model for unknown future catalogs', () => {
    const futureCatalog = models('future/new-fast-model')
    const settings = {
      agentRouting: {
        Explore: { profile: 'fast', fallback: 'first-available' },
      },
    } as SettingsJson

    expect(
      resolveAgentRoute(undefined, 'Explore', settings, futureCatalog),
    ).toEqual({
      model: 'future/new-fast-model',
      source: 'profile',
      profile: 'fast',
    })
  })

  test('keeps legacy external provider routing ahead of profile names', () => {
    const settings = {
      agentModels: {
        fast: { base_url: 'https://fast.example.com/v1', api_key: 'secret' },
      },
      agentRouting: { Explore: 'fast' },
    } as SettingsJson

    expect(
      resolveAgentRoute(undefined, 'Explore', settings, proCatalog),
    ).toEqual({
      model: 'fast',
      source: 'external-provider',
      providerOverride: {
        model: 'fast',
        baseURL: 'https://fast.example.com/v1',
        apiKey: 'secret',
      },
    })
  })

  test('settings schema accepts profile and inherited-model routes', () => {
    const result = SettingsSchema().safeParse({
      agentRouting: {
        Explore: 'fast',
        'worker-review': { profile: 'review' },
        'worker-tests': { profile: 'testing' },
        custom: { model: 'max/mimo-v2.5-pro', provider: 'inherit' },
      },
    })

    expect(result.success).toBe(true)
  })

  test('settings schema rejects unknown profiles', () => {
    const result = SettingsSchema().safeParse({
      agentRouting: {
        Explore: { profile: 'turbo' },
      },
    })

    expect(result.success).toBe(false)
  })
})
