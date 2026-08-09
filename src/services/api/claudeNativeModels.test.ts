import { afterEach, expect, mock, test } from 'bun:test'

import {
  parseClaudeNativeModelsResponse,
  requireClaudeNativeModel,
} from './claudeNativeModels.js'

const payload = {
  data: [
    {
      id: 'claude-opus-current',
      display_name: 'Claude Opus Current',
      max_input_tokens: 200_000,
      max_tokens: 64_000,
      capabilities: {
        image_input: { supported: true },
        effort: {
          supported: true,
          low: { supported: true },
          high: { supported: true },
          max: { supported: false },
        },
      },
    },
    {
      id: 'claude-hidden-from-memory',
      display_name: 'Every API model is preserved',
    },
  ],
  has_more: false,
  last_id: 'claude-hidden-from-memory',
}

test('keeps every exact ID and capability returned by the Claude Models API', () => {
  const page = parseClaudeNativeModelsResponse(payload)

  expect(page.models.map(model => model.id)).toEqual([
    'claude-opus-current',
    'claude-hidden-from-memory',
  ])
  expect(page.models[0]).toMatchObject({
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    vision: true,
    supportedReasoningLevels: ['low', 'high'],
  })
})

test('accepts only exact IDs returned by the Claude Models API', () => {
  const { models } = parseClaudeNativeModelsResponse(payload)

  expect(requireClaudeNativeModel(models, 'claude-opus-current')).toMatchObject({
    id: 'claude-opus-current',
  })
  expect(() => requireClaudeNativeModel(models, 'CLAUDE-OPUS-CURRENT')).toThrow(
    "'CLAUDE-OPUS-CURRENT' não está disponível",
  )
  expect(() => requireClaudeNativeModel(models, 'anything')).toThrow(
    "'anything' não está disponível",
  )
})

afterEach(() => {
  mock.restore()
})

test('fetches and refreshes models for the explicitly selected local account', async () => {
  const readAccountIds: Array<string | undefined> = []
  const refreshAccountIds: Array<string | undefined> = []
  let requests = 0

  mock.module('../../utils/claudeNativeCredentials.js', () => ({
    hasCurrentClaudeRiskAcceptance: () => true,
    readClaudeNativeCredentialsAsync: async (localAccountId?: string) => {
      readAccountIds.push(localAccountId)
      if (localAccountId !== 'local-b') {
        throw new Error('the selected local account must be passed through')
      }
      return {
        accessToken: requests === 0 ? 'expired-token' : 'fresh-token',
        refreshToken: 'refresh-b',
        accountId: 'provider-b',
        scopes: ['user:inference'],
        riskAcceptance: {
          version: 1,
          acceptedAt: '2026-08-09T12:00:00.000Z',
          accountId: 'provider-b',
        },
      }
    },
    refreshClaudeNativeAccessTokenIfNeeded: async (options?: { localAccountId?: string }) => {
      refreshAccountIds.push(options?.localAccountId)
      return {
        refreshed: true,
        credentials: {
          accessToken: 'fresh-token',
          refreshToken: 'refresh-b',
          accountId: 'provider-b',
          scopes: ['user:inference'],
          riskAcceptance: {
            version: 1,
            acceptedAt: '2026-08-09T12:00:00.000Z',
            accountId: 'provider-b',
          },
        },
      }
    },
  }))

  const previousFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    requests += 1
    if (requests === 1) return new Response('expired', { status: 401 })
    return new Response(
      JSON.stringify({
        data: [
          {
            id: 'claude-account-b',
            display_name: 'Account B',
            capabilities: { image_input: { supported: true } },
          },
        ],
        has_more: false,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch

  try {
    // @ts-expect-error cache-busting query string for Bun module isolation
    const { fetchClaudeNativeModels } = await import(
      './claudeNativeModels.js?selected-account'
    )
    const models = await fetchClaudeNativeModels({
      force: true,
      localAccountId: 'local-b',
    })

    expect(models.map(model => model.id)).toEqual(['claude-account-b'])
    expect(readAccountIds).toEqual(['local-b'])
    expect(refreshAccountIds).toEqual(['local-b'])
  } finally {
    globalThis.fetch = previousFetch
  }
})
