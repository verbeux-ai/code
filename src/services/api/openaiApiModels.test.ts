import { afterEach, expect, mock, test } from 'bun:test'

import {
  isOpenAIChatModelId,
  OPENAI_API_MODEL_PREFIX,
  parseOpenAIApiModelsResponse,
} from './openaiApiModels.js'

afterEach(() => {
  mock.restore()
})

test('keeps only chat/reasoning models and prefixes their catalog ids', () => {
  const models = parseOpenAIApiModelsResponse({
    data: [
      { id: 'gpt-5.5' },
      { id: 'o4-mini' },
      { id: 'text-embedding-3-large' },
      { id: 'gpt-4o-mini-tts' },
      { id: 'gpt-image-1' },
      { id: 'whisper-1' },
      { id: 'gpt-4o-realtime-preview' },
      { id: 'gpt-5.5' },
    ],
  })
  expect(models.map(model => model.upstreamId)).toEqual(['o4-mini', 'gpt-5.5'])
  expect(models.map(model => model.id)).toEqual([
    `${OPENAI_API_MODEL_PREFIX}o4-mini`,
    `${OPENAI_API_MODEL_PREFIX}gpt-5.5`,
  ])
  expect(models[1]?.displayName).toContain('sua chave OpenAI')
})

test('chat model filter', () => {
  expect(isOpenAIChatModelId('gpt-5.5')).toBe(true)
  expect(isOpenAIChatModelId('chatgpt-4o-latest')).toBe(true)
  expect(isOpenAIChatModelId('o3')).toBe(true)
  expect(isOpenAIChatModelId('dall-e-3')).toBe(false)
  expect(isOpenAIChatModelId('omni-moderation-latest')).toBe(false)
})

test('lists models with the given key as a Bearer token', async () => {
  const seen: Array<{ url: string; auth?: string }> = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    seen.push({
      url: String(url),
      auth: (init?.headers as Record<string, string>)?.Authorization,
    })
    return new Response(JSON.stringify({ data: [{ id: 'gpt-5.5' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  try {
    // @ts-expect-error cache-busting query string for Bun module isolation
    const api = await import('./openaiApiModels.js?fetch')
    const models = await api.fetchOpenAIApiModels({
      force: true,
      credential: { apiKey: 'sk-proj-abcdefghijklmnopqrstuvwx', keyHint: 'uvwx' },
    })
    expect(models.map((model: { id: string }) => model.id)).toEqual([
      `${OPENAI_API_MODEL_PREFIX}gpt-5.5`,
    ])
    expect(seen).toEqual([
      { url: 'https://api.openai.com/v1/models', auth: 'Bearer sk-proj-abcdefghijklmnopqrstuvwx' },
    ])
    // A candidate key is only being validated: the catalog stays as it was.
    expect(api.getOpenAIApiModel(`${OPENAI_API_MODEL_PREFIX}gpt-5.5`)).toBeUndefined()
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('a rejected key surfaces the HTTP status', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response('bad key', { status: 401 })) as unknown as typeof fetch
  try {
    // @ts-expect-error cache-busting query string for Bun module isolation
    const api = await import('./openaiApiModels.js?reject')
    await expect(
      api.fetchOpenAIApiModels({
        force: true,
        credential: { apiKey: 'sk-proj-abcdefghijklmnopqrstuvwx', keyHint: 'uvwx' },
      }),
    ).rejects.toMatchObject({ status: 401 })
  } finally {
    globalThis.fetch = previousFetch
  }
})
