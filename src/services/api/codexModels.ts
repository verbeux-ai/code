import { z } from 'zod'

import {
  readCodexCredentialsAsync,
  refreshCodexAccessTokenIfNeeded,
  type CodexCredentialBlob,
} from '../../utils/codexCredentials.js'
import { parseChatgptAccountId } from './codexOAuthShared.js'
import { DEFAULT_CODEX_BASE_URL } from './providerConfig.js'
import { getVerbooCodeUserAgent } from '../../utils/userAgent.js'
import type { LocalProviderAccountId } from '../../utils/providerAccounts/types.js'
import { getSelectedProviderAccount } from '../../utils/providerAccounts/selection.js'

const CACHE_TTL_MS = 5 * 60 * 1_000

const reasoningLevelSchema = z
  .object({
    effort: z.string().min(1),
    description: z.string().optional(),
  })
  .passthrough()

const codexModelSchema = z
  .object({
    slug: z.string().min(1),
    display_name: z.string().min(1).optional(),
    description: z.string().nullish(),
    default_reasoning_level: z.string().nullish(),
    supported_reasoning_levels: z.array(reasoningLevelSchema).default([]),
    visibility: z.string().optional(),
    supported_in_api: z.boolean().optional(),
    priority: z.number().int().default(999),
    context_window: z.number().int().positive().nullish(),
  })
  .passthrough()

const modelsResponseSchema = z.object({
  models: z.array(codexModelSchema),
})

export type CodexModel = {
  id: string
  displayName: string
  description?: string
  defaultReasoningLevel?: string
  supportedReasoningLevels: Array<{
    effort: string
    description?: string
  }>
  visibility?: string
  supportedInApi?: boolean
  priority: number
  contextWindow?: number
}

type CacheEntry = {
  fetchedAt: number
  etag?: string
  models: CodexModel[]
}

const cacheByAccount = new Map<string, CacheEntry>()
let cacheGeneration = 0

function resolveCredentials(credentials: CodexCredentialBlob): {
  apiKey: string
  accountId: string
} {
  const apiKey = credentials.apiKey ?? credentials.accessToken
  const accountId =
    credentials.accountId ??
    parseChatgptAccountId(credentials.idToken) ??
    parseChatgptAccountId(credentials.accessToken)
  if (!apiKey || !accountId) {
    throw new Error(
      'Login Codex incompleto. Execute `/codex login` para autenticar novamente.',
    )
  }
  return { apiKey, accountId }
}

function clientVersion(): string {
  try {
    return MACRO.VERSION || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export function parseCodexModelsResponse(payload: unknown): CodexModel[] {
  const parsed = modelsResponseSchema.parse(payload)
  const seen = new Set<string>()
  return parsed.models
    .slice()
    .sort((a, b) => a.priority - b.priority)
    .flatMap(model => {
      const id = model.slug.trim()
      if (!id || seen.has(id)) return []
      seen.add(id)
      return [
        {
          id,
          displayName: model.display_name?.trim() || id,
          description: model.description ?? undefined,
          defaultReasoningLevel: model.default_reasoning_level ?? undefined,
          supportedReasoningLevels: model.supported_reasoning_levels,
          visibility: model.visibility,
          supportedInApi: model.supported_in_api,
          priority: model.priority,
          contextWindow: model.context_window ?? undefined,
        },
      ]
    })
}

async function requestModels(
  credentials: CodexCredentialBlob,
  previous: CacheEntry | undefined,
): Promise<CacheEntry> {
  const resolved = resolveCredentials(credentials)
  const endpoint = `${DEFAULT_CODEX_BASE_URL}/models?client_version=${encodeURIComponent(clientVersion())}`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${resolved.apiKey}`,
    'chatgpt-account-id': resolved.accountId,
    originator: 'verboo',
    'User-Agent': getVerbooCodeUserAgent(),
  }
  if (previous?.etag) headers['If-None-Match'] = previous.etag

  const response = await fetch(endpoint, { headers })
  if (response.status === 304 && previous) {
    return { ...previous, fetchedAt: Date.now() }
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).trim().slice(0, 500)
    throw Object.assign(
      new Error(
        detail
          ? `A API de modelos do Codex respondeu ${response.status}: ${detail}`
          : `A API de modelos do Codex respondeu ${response.status}.`,
      ),
      { status: response.status },
    )
  }

  return {
    fetchedAt: Date.now(),
    etag: response.headers.get('etag') ?? undefined,
    models: parseCodexModelsResponse(await response.json()),
  }
}

function cacheKey(
  localAccountId: LocalProviderAccountId | undefined,
  providerAccountId: string,
): string {
  return localAccountId ?? `legacy:${providerAccountId}`
}

async function loadModels(
  force: boolean,
  localAccountId?: LocalProviderAccountId,
): Promise<CodexModel[]> {
  const effectiveLocalAccountId =
    localAccountId ??
    (getSelectedProviderAccount()?.provider === 'codex'
      ? getSelectedProviderAccount()?.accountId
      : undefined)
  const generation = cacheGeneration
  let stored = await readCodexCredentialsAsync(effectiveLocalAccountId)
  if (!stored) {
    throw new Error('Codex não autenticado. Execute `/codex login`.')
  }

  const initial = resolveCredentials(stored)
  const selectedCacheKey = cacheKey(effectiveLocalAccountId, initial.accountId)
  const previous = cacheByAccount.get(selectedCacheKey)
  if (!force && previous && Date.now() - previous.fetchedAt < CACHE_TTL_MS) {
    return previous.models
  }

  try {
    const entry = await requestModels(stored, previous)
    if (generation === cacheGeneration) {
      cacheByAccount.set(selectedCacheKey, entry)
    }
    return entry.models
  } catch (error) {
    if ((error as { status?: number }).status !== 401) throw error
    const refreshed = await refreshCodexAccessTokenIfNeeded({
      force: true,
      ignoreEnvironment: true,
      localAccountId: effectiveLocalAccountId,
    })
    stored = refreshed.credentials ?? (await readCodexCredentialsAsync(effectiveLocalAccountId))
    if (!stored) throw error
    const resolved = resolveCredentials(stored)
    const refreshedCacheKey = cacheKey(effectiveLocalAccountId, resolved.accountId)
    const entry = await requestModels(stored, cacheByAccount.get(refreshedCacheKey))
    if (generation === cacheGeneration) {
      cacheByAccount.set(refreshedCacheKey, entry)
    }
    return entry.models
  }
}

export async function fetchCodexModels(options?: {
  force?: boolean
  localAccountId?: LocalProviderAccountId
}): Promise<CodexModel[]> {
  return loadModels(options?.force === true, options?.localAccountId)
}

export function getCachedCodexModels(
  localAccountId?: LocalProviderAccountId,
): CodexModel[] | null {
  const effectiveLocalAccountId =
    localAccountId ??
    (getSelectedProviderAccount()?.provider === 'codex'
      ? getSelectedProviderAccount()?.accountId
      : undefined)
  if (effectiveLocalAccountId) {
    const selected = cacheByAccount.get(effectiveLocalAccountId)
    if (selected) return selected.models
  }
  for (const entry of cacheByAccount.values()) {
    return entry.models
  }
  return null
}

export function clearCodexModelsCache(): void {
  cacheGeneration += 1
  cacheByAccount.clear()
}

export function getCodexModel(
  modelId: string,
  localAccountId?: LocalProviderAccountId,
): CodexModel | undefined {
  return getCachedCodexModels(localAccountId)?.find(model => model.id === modelId)
}

export function getCodexReasoningLevels(
  modelId: string,
  localAccountId?: LocalProviderAccountId,
): string[] {
  return (
    getCodexModel(modelId, localAccountId)?.supportedReasoningLevels.map(level => level.effort) ??
    []
  )
}

export function getCodexReasoningEffort(
  modelId: string,
  requested: string,
  localAccountId?: LocalProviderAccountId,
): string | undefined {
  const normalized = requested.trim().toLowerCase()
  const apiValue = normalized === 'max' ? 'xhigh' : normalized
  return getCodexReasoningLevels(modelId, localAccountId).find(
    level => level.toLowerCase() === apiValue,
  )
}

export function requireCodexModel(
  models: readonly CodexModel[],
  model: string,
): CodexModel {
  const requested = model.trim()
  if (!requested) throw new Error('Informe um modelo do catálogo Codex.')
  const match = models.find(candidate => candidate.id === requested)
  if (!match) {
    throw new Error(
      `O modelo '${requested}' não está disponível para esta conta Codex. Execute /model para escolher um modelo do catálogo atual.`,
    )
  }
  return match
}

export async function assertCodexModelAvailable(
  model: string,
  localAccountId?: LocalProviderAccountId,
): Promise<CodexModel> {
  const models = await fetchCodexModels({ localAccountId })
  return requireCodexModel(models, model)
}
