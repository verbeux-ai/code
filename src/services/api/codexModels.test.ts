import { afterEach, expect, mock, test } from 'bun:test'

import {
  parseCodexModelsResponse,
  requireCodexModel,
} from './codexModels.js'

const payload = {
  models: [
    {
      slug: 'gpt-codex-later',
      display_name: 'Later',
      priority: 20,
      visibility: 'hidden',
      supported_in_api: false,
      supported_reasoning_levels: [],
    },
    {
      slug: 'gpt-codex-first',
      display_name: 'First',
      priority: 1,
      supported_reasoning_levels: [
        { effort: 'low' },
        { effort: 'xhigh' },
      ],
    },
  ],
}

test('keeps every slug returned by the Codex models API', () => {
  const models = parseCodexModelsResponse(payload)

  expect(models.map(model => model.id)).toEqual([
    'gpt-codex-first',
    'gpt-codex-later',
  ])
  expect(models[1]).toMatchObject({
    visibility: 'hidden',
    supportedInApi: false,
  })
})

test('accepts exact API slugs and rejects arbitrary model values', () => {
  const models = parseCodexModelsResponse(payload)

  expect(requireCodexModel(models, 'gpt-codex-first')).toMatchObject({
    id: 'gpt-codex-first',
  })
  expect(() => requireCodexModel(models, 'GPT-CODEX-FIRST')).toThrow(
    "'GPT-CODEX-FIRST' não está disponível",
  )
  expect(() => requireCodexModel(models, 'anything')).toThrow(
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

  mock.module('../../utils/codexCredentials.js', () => ({
    readCodexCredentialsAsync: async (localAccountId?: string) => {
      readAccountIds.push(localAccountId)
      if (localAccountId !== 'local-b') {
        throw new Error('the selected local account must be passed through')
      }
      return {
        accessToken: requests === 0 ? 'expired-token' : 'fresh-token',
        refreshToken: 'refresh-b',
        accountId: 'provider-b',
      }
    },
    refreshCodexAccessTokenIfNeeded: async (options?: { localAccountId?: string }) => {
      refreshAccountIds.push(options?.localAccountId)
      return {
        refreshed: true,
        credentials: {
          accessToken: 'fresh-token',
          refreshToken: 'refresh-b',
          accountId: 'provider-b',
        },
      }
    },
  }))

  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (_input, init) => {
    requests += 1
    const accountId = new Headers(init?.headers).get('chatgpt-account-id')
    expect(accountId).toBe('provider-b')
    if (requests === 1) return new Response('expired', { status: 401 })
    return new Response(
      JSON.stringify({
        models: [
          {
            slug: 'gpt-codex-account-b',
            display_name: 'Account B',
            priority: 1,
            supported_reasoning_levels: [],
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch

  try {
    // @ts-expect-error cache-busting query string for Bun module isolation
    const { fetchCodexModels } = await import('./codexModels.js?selected-account')
    const models = await fetchCodexModels({
      force: true,
      localAccountId: 'local-b',
    })

    expect(models.map(model => model.id)).toEqual(['gpt-codex-account-b'])
    expect(readAccountIds).toEqual(['local-b'])
    expect(refreshAccountIds).toEqual(['local-b'])
  } finally {
    globalThis.fetch = previousFetch
  }
})
