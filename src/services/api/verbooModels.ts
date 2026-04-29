import axios from 'axios'

import { VERBOO_ROUTER_URL } from '../../constants/oauth.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'

export type VerbooModel = {
  id: string
  contextWindow?: number
  maxOutputTokens?: number
  displayName?: string
  description?: string
  raw: Record<string, unknown>
}

type ModelsResponse = {
  object?: string
  data?: Array<Record<string, unknown>>
}

const CACHE_TTL_MS = 5 * 60 * 1000

let cache: { fetchedAt: number; models: VerbooModel[] } | null = null
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
    raw,
  }
}

export function clearVerbooModelsCache(): void {
  cache = null
  inflight = null
}

export async function fetchVerbooModels(
  accessToken: string,
  opts: { force?: boolean } = {},
): Promise<VerbooModel[]> {
  if (!opts.force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.models
  }
  if (inflight) return inflight

  const endpoint = `${VERBOO_ROUTER_URL}/v1/models`
  inflight = (async () => {
    try {
      const response = await axios.get<ModelsResponse>(endpoint, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 10_000,
      })
      const data = response.data?.data ?? []
      const models = data
        .map(normalizeModel)
        .filter((m): m is VerbooModel => m !== null)
      cache = { fetchedAt: Date.now(), models }
      logForDebugging(
        `[VerbooModels] Fetched ${models.length} models from ${endpoint}`,
      )
      return models
    } catch (error) {
      logError(error as Error)
      const msg = `[Verboo] Erro ao buscar modelos de ${endpoint}: ${(error as Error).message ?? String(error)}`
      logForDebugging(msg)
      process.stderr.write(msg + '\n')
      // Em caso de falha, devolve cache stale se houver, ou lista vazia.
      return cache?.models ?? []
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export function getCachedVerbooModels(): VerbooModel[] | null {
  return cache?.models ?? null
}

export function getVerbooModelMeta(modelId: string): VerbooModel | undefined {
  if (!cache) return undefined
  return cache.models.find(m => m.id === modelId)
}
