import { z } from 'zod/v4'

import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import {
  readOpenAIApiKeyCredentialAsync,
  type OpenAIApiKeyCredential,
} from '../../utils/openaiApiKeyCredentials.js'
import { getVerbooCodeUserAgent } from '../../utils/userAgent.js'

export const OPENAI_API_BASE_URL = 'https://api.openai.com/v1'

/**
 * Catalog ids carry this prefix so a model reached with the user's OpenAI key
 * never collides with the same GPT model offered through Codex (ChatGPT plan)
 * or the Verboo router. The prefix is stripped before calling OpenAI.
 */
export const OPENAI_API_MODEL_PREFIX = 'openai-api/'

const CACHE_TTL_MS = 5 * 60 * 1_000
const REQUEST_TIMEOUT_MS = 10_000

const responseSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) }).passthrough()),
})

export type OpenAIApiModel = {
  /** Catalog id shown in /model, e.g. openai-api/gpt-5.5 */
  id: string
  /** Id sent to the OpenAI API, e.g. gpt-5.5 */
  upstreamId: string
  displayName: string
  description: string
}

let cache: { fetchedAt: number; models: OpenAIApiModel[] } | null = null
let cacheGeneration = 0

// The Models API also lists embeddings, audio, image and moderation models;
// only chat/reasoning models can drive the agent.
const CHAT_MODEL = /^(gpt-|o\d|chatgpt-)/
const NON_CHAT_MODEL =
  /(embedding|whisper|tts|dall-e|image|audio|realtime|transcribe|moderation|search|computer-use|instruct)/
// Chat Completions rejects the Responses-only models, and the legacy ones have
// no tool support or too little context to drive the agent.
const UNUSABLE_MODEL =
  /(-pro(-|$)|codex|deep-research|^gpt-3\.5|^gpt-4(-|$)|^o1-(mini|preview))/

export function isOpenAIChatModelId(id: string): boolean {
  return CHAT_MODEL.test(id) && !NON_CHAT_MODEL.test(id) && !UNUSABLE_MODEL.test(id)
}

export function parseOpenAIApiModelsResponse(payload: unknown): OpenAIApiModel[] {
  const parsed = responseSchema.parse(payload)
  const ids = [...new Set(parsed.data.map(model => model.id))]
    .filter(isOpenAIChatModelId)
    .sort((a, b) => b.localeCompare(a))
  return ids.map(upstreamId => ({
    id: `${OPENAI_API_MODEL_PREFIX}${upstreamId}`,
    upstreamId,
    displayName: `${upstreamId} (sua chave OpenAI)`,
    description: `${upstreamId} · cobrado pela OpenAI na sua chave`,
  }))
}

export async function fetchOpenAIApiModels(options?: {
  force?: boolean
  credential?: OpenAIApiKeyCredential
}): Promise<OpenAIApiModel[]> {
  const generation = cacheGeneration
  const credential = options?.credential ?? (await readOpenAIApiKeyCredentialAsync())
  if (!credential) {
    throw new Error('OpenAI não conectada. Execute `/openai login` com sua chave de API.')
  }
  if (!options?.force && !options?.credential && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.models
  }
  const timeout = createCombinedAbortSignal(undefined, { timeoutMs: REQUEST_TIMEOUT_MS })
  try {
    const response = await fetch(`${OPENAI_API_BASE_URL}/models`, {
      signal: timeout.signal,
      headers: {
        Authorization: `Bearer ${credential.apiKey}`,
        'User-Agent': getVerbooCodeUserAgent(),
      },
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).trim().slice(0, 300)
      throw Object.assign(
        new Error(
          detail
            ? `A Models API da OpenAI respondeu ${response.status}: ${detail}`
            : `A Models API da OpenAI respondeu ${response.status}.`,
        ),
        { status: response.status },
      )
    }
    const models = parseOpenAIApiModelsResponse(await response.json())
    // A candidate key is only being validated: until it is saved, the catalog
    // must keep describing the stored key.
    if (!options?.credential && generation === cacheGeneration) {
      cache = { fetchedAt: Date.now(), models }
    }
    return models
  } finally {
    timeout.cleanup()
  }
}

export function getCachedOpenAIApiModels(): OpenAIApiModel[] | null {
  return cache?.models ?? null
}

export function getOpenAIApiModel(id: string): OpenAIApiModel | undefined {
  return cache?.models.find(model => model.id === id)
}

export function clearOpenAIApiModelsCache(): void {
  cache = null
  cacheGeneration += 1
}
