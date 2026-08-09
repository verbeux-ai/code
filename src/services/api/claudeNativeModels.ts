import { z } from 'zod'

import {
  hasCurrentClaudeRiskAcceptance,
  readClaudeNativeCredentialsAsync,
  refreshClaudeNativeAccessTokenIfNeeded,
  type ClaudeNativeCredentialBlob,
} from '../../utils/claudeNativeCredentials.js'
import {
  CLAUDE_NATIVE_API_BASE_URL,
  CLAUDE_NATIVE_API_VERSION,
  CLAUDE_NATIVE_OAUTH_BETA,
} from './claudeNativeConfig.js'
import { getVerbooCodeUserAgent } from '../../utils/userAgent.js'
import type { LocalProviderAccountId } from '../../utils/providerAccounts/types.js'
import { getSelectedProviderAccount } from '../../utils/providerAccounts/selection.js'

const CACHE_TTL_MS = 5 * 60 * 1_000

const capabilitySchema = z
  .object({ supported: z.boolean().optional() })
  .passthrough()

const modelSchema = z
  .object({
    id: z.string().min(1),
    display_name: z.string().min(1).optional(),
    max_input_tokens: z.number().int().positive().nullish(),
    max_tokens: z.number().int().positive().nullish(),
    capabilities: z
      .object({
        image_input: capabilitySchema.optional(),
        effort: z
          .object({
            supported: z.boolean().optional(),
            low: capabilitySchema.optional(),
            medium: capabilitySchema.optional(),
            high: capabilitySchema.optional(),
            max: capabilitySchema.optional(),
            xhigh: capabilitySchema.optional(),
          })
          .passthrough()
          .nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough()

const responseSchema = z
  .object({
    data: z.array(modelSchema),
    has_more: z.boolean().optional(),
    last_id: z.string().nullish(),
  })
  .passthrough()

export type ClaudeNativeModel = {
  id: string
  displayName: string
  contextWindow?: number
  maxOutputTokens?: number
  vision?: boolean
  supportedReasoningLevels: string[]
  raw: Record<string, unknown>
}

type CacheEntry = {
  fetchedAt: number
  models: ClaudeNativeModel[]
}

const cacheByAccount = new Map<string, CacheEntry>()
let cacheGeneration = 0

function normalizeModel(raw: z.infer<typeof modelSchema>): ClaudeNativeModel {
  const effort = raw.capabilities?.effort
  const supportedReasoningLevels = ['low', 'medium', 'high', 'max', 'xhigh'].filter(
    level =>
      (effort?.[level as keyof typeof effort] as { supported?: boolean } | undefined)
        ?.supported === true,
  )
  return {
    id: raw.id.trim(),
    displayName: raw.display_name?.trim() || raw.id.trim(),
    contextWindow: raw.max_input_tokens ?? undefined,
    maxOutputTokens: raw.max_tokens ?? undefined,
    vision: raw.capabilities?.image_input?.supported,
    supportedReasoningLevels,
    raw: raw as Record<string, unknown>,
  }
}

export function parseClaudeNativeModelsResponse(payload: unknown): {
  models: ClaudeNativeModel[]
  hasMore: boolean
  lastId?: string
} {
  const parsed = responseSchema.parse(payload)
  const seen = new Set<string>()
  const models = parsed.data.flatMap(raw => {
    const model = normalizeModel(raw)
    if (!model.id || seen.has(model.id)) return []
    seen.add(model.id)
    return [model]
  })
  return {
    models,
    hasMore: parsed.has_more === true,
    lastId: parsed.last_id ?? undefined,
  }
}

function headers(credentials: ClaudeNativeCredentialBlob): Record<string, string> {
  return {
    Authorization: `Bearer ${credentials.accessToken}`,
    'anthropic-version': CLAUDE_NATIVE_API_VERSION,
    'anthropic-beta': CLAUDE_NATIVE_OAUTH_BETA,
    'User-Agent': getVerbooCodeUserAgent(),
  }
}

async function requestAllModels(
  credentials: ClaudeNativeCredentialBlob,
): Promise<ClaudeNativeModel[]> {
  const models: ClaudeNativeModel[] = []
  const seen = new Set<string>()
  let afterId: string | undefined
  for (;;) {
    const url = new URL(`${CLAUDE_NATIVE_API_BASE_URL}/v1/models`)
    url.searchParams.set('limit', '1000')
    if (afterId) url.searchParams.set('after_id', afterId)
    const response = await fetch(url, { headers: headers(credentials) })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).trim().slice(0, 500)
      throw Object.assign(
        new Error(
          detail
            ? `A Models API do Claude respondeu ${response.status}: ${detail}`
            : `A Models API do Claude respondeu ${response.status}.`,
        ),
        { status: response.status },
      )
    }
    const page = parseClaudeNativeModelsResponse(await response.json())
    for (const model of page.models) {
      if (!seen.has(model.id)) {
        seen.add(model.id)
        models.push(model)
      }
    }
    if (!page.hasMore) return models
    if (!page.lastId || page.lastId === afterId) {
      throw new Error('A Models API do Claude retornou paginação inválida.')
    }
    afterId = page.lastId
  }
}

export async function fetchClaudeNativeModels(options?: {
  force?: boolean
  localAccountId?: LocalProviderAccountId
  credentials?: ClaudeNativeCredentialBlob
}): Promise<ClaudeNativeModel[]> {
  const effectiveLocalAccountId =
    options?.localAccountId ??
    (getSelectedProviderAccount()?.provider === 'claude'
      ? getSelectedProviderAccount()?.accountId
      : undefined)
  const generation = cacheGeneration
  let credentials = options?.credentials ?? (await readClaudeNativeCredentialsAsync(effectiveLocalAccountId))
  if (!credentials || !hasCurrentClaudeRiskAcceptance(credentials)) {
    throw new Error('Claude não autenticado. Execute `/claude login`.')
  }
  const cacheKey = effectiveLocalAccountId ?? `legacy:${credentials.accountId}`
  const previous = cacheByAccount.get(cacheKey)
  if (!options?.force && previous && Date.now() - previous.fetchedAt < CACHE_TTL_MS) {
    return previous.models
  }
  try {
    const models = await requestAllModels(credentials)
    if (generation === cacheGeneration) {
      cacheByAccount.set(cacheKey, { fetchedAt: Date.now(), models })
    }
    return models
  } catch (error) {
    if (options?.credentials || (error as { status?: number }).status !== 401) {
      throw error
    }
    const refreshed = await refreshClaudeNativeAccessTokenIfNeeded({
      force: true,
      localAccountId: effectiveLocalAccountId,
    })
    credentials = refreshed.credentials ?? (await readClaudeNativeCredentialsAsync(effectiveLocalAccountId))
    if (!credentials) throw error
    const models = await requestAllModels(credentials)
    if (generation === cacheGeneration) {
      cacheByAccount.set(cacheKey, { fetchedAt: Date.now(), models })
    }
    return models
  }
}

export function getCachedClaudeNativeModels(
  localAccountId?: LocalProviderAccountId,
): ClaudeNativeModel[] | null {
  const effectiveLocalAccountId =
    localAccountId ??
    (getSelectedProviderAccount()?.provider === 'claude'
      ? getSelectedProviderAccount()?.accountId
      : undefined)
  if (effectiveLocalAccountId) {
    const selected = cacheByAccount.get(effectiveLocalAccountId)
    if (selected) return selected.models
  }
  for (const entry of cacheByAccount.values()) return entry.models
  return null
}

export function clearClaudeNativeModelsCache(): void {
  cacheGeneration += 1
  cacheByAccount.clear()
}

export function getClaudeNativeModel(
  modelId: string,
  localAccountId?: LocalProviderAccountId,
): ClaudeNativeModel | undefined {
  return getCachedClaudeNativeModels(localAccountId)?.find(model => model.id === modelId)
}

export function getClaudeNativeReasoningEffort(
  modelId: string,
  requested: string,
  localAccountId?: LocalProviderAccountId,
): string | undefined {
  const normalized = requested.trim().toLowerCase()
  return getClaudeNativeModel(modelId, localAccountId)?.supportedReasoningLevels.find(
    level => level.toLowerCase() === normalized,
  )
}

export function requireClaudeNativeModel(
  models: readonly ClaudeNativeModel[],
  modelId: string,
): ClaudeNativeModel {
  const match = models.find(model => model.id === modelId.trim())
  if (!match) {
    throw new Error(
      `O modelo '${modelId}' não está disponível para esta conta Claude. Execute /model para escolher um modelo do catálogo atual.`,
    )
  }
  return match
}

export async function assertClaudeNativeModelAvailable(
  modelId: string,
  localAccountId?: LocalProviderAccountId,
): Promise<ClaudeNativeModel> {
  return requireClaudeNativeModel(
    await fetchClaudeNativeModels({ localAccountId }),
    modelId,
  )
}
