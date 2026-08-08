import axios from 'axios'
import { z } from 'zod'

import { VERBOO_ROUTER_URL } from '../../constants/oauth.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { toVerbooApiError, VerbooApiError } from './verbooApiError.js'

export type VerbooModel = {
  id: string
  contextWindow?: number
  maxOutputTokens?: number
  displayName?: string
  description?: string
  vision?: boolean
  reasoning?: VerbooModelReasoning
  raw: Record<string, unknown>
}

export type VerbooModelReasoning = {
  effortLevels: string[]
  defaultEffort: string
}

export const VERBOO_AGENT_MODEL_ROLES = [
  'explore',
  'fast',
  'balanced',
  'powerful',
  'review',
  'coding',
  'testing',
] as const

export type VerbooAgentModelRole = (typeof VERBOO_AGENT_MODEL_ROLES)[number]
export type VerbooAgentModelRoles = Partial<
  Record<VerbooAgentModelRole, string>
>

const modelsResponseSchema = z
  .object({
    data: z.array(z.record(z.unknown())),
    agent_model_roles: z.record(z.unknown()).optional(),
  })
  .passthrough()

const CACHE_TTL_MS = 5 * 60 * 1000

let cache: {
  fetchedAt: number
  models: VerbooModel[]
  agentModelRoles: VerbooAgentModelRoles
} | null = null
let inflight: Promise<VerbooModel[]> | null = null

function pickNumber(
  source: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const v = source[key]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

function pickString(
  source: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const v = source[key]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

function normalizeReasoning(
  raw: Record<string, unknown>,
): VerbooModelReasoning | undefined {
  const source = raw.reasoning
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return undefined
  }
  const reasoning = source as Record<string, unknown>
  const rawLevels = reasoning.effort_levels ?? reasoning.effortLevels
  if (!Array.isArray(rawLevels)) return undefined

  const effortLevels = [
    ...new Set(
      rawLevels
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ]
  const defaultEffort = pickString(
    reasoning,
    'default_effort',
    'defaultEffort',
  )?.trim()
  const canonicalDefault = defaultEffort
    ? effortLevels.find(
        (level) => level.toLowerCase() === defaultEffort.toLowerCase(),
      )
    : undefined
  if (!canonicalDefault) {
    return undefined
  }
  return { effortLevels, defaultEffort: canonicalDefault }
}

function normalizeModel(raw: Record<string, unknown>): VerbooModel | null {
  const id = pickString(raw, 'id', 'name', 'model')
  if (!id) return null
  return {
    id,
    contextWindow: pickNumber(
      raw,
      'context_window',
      'contextWindow',
      'context_length',
      'max_input_tokens',
    ),
    maxOutputTokens: pickNumber(
      raw,
      'max_output_tokens',
      'maxOutputTokens',
      'max_completion_tokens',
    ),
    displayName: pickString(raw, 'display_name', 'displayName', 'label'),
    description: pickString(raw, 'description'),
    vision: typeof raw.vision === 'boolean' ? raw.vision : undefined,
    reasoning: normalizeReasoning(raw),
    raw,
  }
}

function normalizeAgentModelRoles(
  rawRoles: Record<string, unknown> | undefined,
  models: VerbooModel[],
): VerbooAgentModelRoles {
  if (!rawRoles) return {}

  const entitledModelIds = new Set(models.map(model => model.id))
  const roles: VerbooAgentModelRoles = {}
  for (const role of VERBOO_AGENT_MODEL_ROLES) {
    const rawModelId = rawRoles[role]
    const modelId =
      typeof rawModelId === 'string' ? rawModelId.trim() : undefined
    if (!modelId) continue
    if (!entitledModelIds.has(modelId)) {
      logForDebugging(
        `[VerbooModels] Ignoring agent model role "${role}" because "${modelId}" is not in the authenticated model catalog`,
        { level: 'warn' },
      )
      continue
    }
    roles[role] = modelId
  }
  return roles
}

export function clearVerbooModelsCache(): void {
  cache = null
  inflight = null
}

export async function fetchVerbooModels(
  accessToken: string,
  opts: { force?: boolean; signal?: AbortSignal } = {},
): Promise<VerbooModel[]> {
  if (!opts.force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.models
  }
  if (inflight) return inflight

  const endpoint = `${VERBOO_ROUTER_URL}/models`
  inflight = (async () => {
    try {
      const response = await axios.get(endpoint, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 10_000,
        signal: opts.signal,
      })
      const parsed = modelsResponseSchema.safeParse(response.data)
      if (!parsed.success) {
        throw new VerbooApiError({
          message: 'Resposta inválida ao consultar os modelos.',
          kind: 'contract',
          code: 'contract_error',
          cause: parsed.error,
        })
      }
      const data = parsed.data.data
      const models = data
        .map(normalizeModel)
        .filter((m): m is VerbooModel => m !== null)
      const agentModelRoles = normalizeAgentModelRoles(
        parsed.data.agent_model_roles,
        models,
      )
      cache = { fetchedAt: Date.now(), models, agentModelRoles }
      logForDebugging(
        `[VerbooModels] Fetched ${models.length} models from ${endpoint}`,
      )
      return models
    } catch (error) {
      if (opts.signal?.aborted || axios.isCancel(error)) throw error
      const apiError = toVerbooApiError(
        error,
        'Não foi possível consultar os modelos.',
      )
      logError(apiError)
      logForDebugging(
        `[VerbooModels] ${apiError.code ?? apiError.kind}: ${apiError.message}`,
      )
      // Um cache com modelos ainda permite que uma sessão em andamento continue.
      // Nunca converta uma falha de rede em uma lista vazia: no startup isso era
      // interpretado como "conta sem modelos" e abria o fluxo de compra.
      if (cache && cache.models.length > 0) {
        return cache.models
      }
      throw apiError
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export function getCachedVerbooModels(): VerbooModel[] | null {
  return cache?.models ?? null
}

export function getCachedVerbooAgentModelRoles(): VerbooAgentModelRoles | null {
  return cache?.agentModelRoles ?? null
}

export function getVerbooAgentModelForRole(
  role: VerbooAgentModelRole,
): string | undefined {
  return cache?.agentModelRoles[role]
}

export function getVerbooModelMeta(modelId: string): VerbooModel | undefined {
  if (!cache) return undefined
  return cache.models.find((m) => m.id === modelId)
}

export function getVerbooModelReasoning(
  modelId: string,
): VerbooModelReasoning | undefined {
  return getVerbooModelMeta(modelId)?.reasoning
}

/**
 * Resolves user/environment input to the exact API value advertised by the
 * current model. Matching is case-insensitive, while the value sent on the
 * wire remains the server-provided canonical value.
 */
export function getVerbooReasoningEffort(
  modelId: string,
  requested: string,
): string | undefined {
  const normalized = requested.trim().toLowerCase()
  if (!normalized) return undefined
  return getVerbooModelReasoning(modelId)?.effortLevels.find(
    (level) => level.toLowerCase() === normalized,
  )
}
