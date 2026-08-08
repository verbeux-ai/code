import type { SettingsJson } from '../../utils/settings/types.js'
import type { VerbooModel } from './verbooModels.js'

export const AGENT_MODEL_PROFILES = {
  fast: [
    'deepseek-v4-flash',
    'glm-4.7-flash',
    'mimo-v2.5',
    'qwen3.6-27b',
    'minimax-m3',
    'mimo-v2.5-pro',
    'deepseek-v4-pro',
    'kimi-k2.7',
    'glm-5.2',
  ],
  review: [
    'deepseek-v4-pro',
    'mimo-v2.5-pro',
    'glm-5.2',
    'kimi-k2.7',
    'qwen3.6-27b',
    'minimax-m3',
    'mimo-v2.5',
    'deepseek-v4-flash',
    'glm-4.7-flash',
  ],
  coding: [
    'mimo-v2.5-pro',
    'deepseek-v4-pro',
    'glm-5.2',
    'kimi-k2.7',
    'qwen3.6-27b',
    'minimax-m3',
    'mimo-v2.5',
    'deepseek-v4-flash',
    'glm-4.7-flash',
  ],
  testing: [
    'qwen3.6-27b',
    'deepseek-v4-pro',
    'mimo-v2.5-pro',
    'mimo-v2.5',
    'minimax-m3',
    'deepseek-v4-flash',
    'glm-5.2',
    'kimi-k2.7',
    'glm-4.7-flash',
  ],
  balanced: [
    'mimo-v2.5',
    'qwen3.6-27b',
    'minimax-m3',
    'deepseek-v4-flash',
    'glm-4.7-flash',
    'mimo-v2.5-pro',
    'deepseek-v4-pro',
    'kimi-k2.7',
    'glm-5.2',
  ],
} as const

export type AgentModelProfile = keyof typeof AGENT_MODEL_PROFILES

const DEFAULT_AGENT_PROFILES: Readonly<Record<string, AgentModelProfile>> = {
  explore: 'fast',
}

export interface ResolvedAgentRoute {
  model: string
  source: 'external-provider' | 'profile' | 'verboo-model'
  profile?: AgentModelProfile
  providerOverride?: ProviderOverride
}

/**
 * Provider override resolved from agent routing config.
 * When present, the API client should use these instead of global env vars.
 */
export interface ProviderOverride {
  /** Model name to send to the API (e.g. "deepseek-chat", "gpt-4o") */
  model: string
  /** OpenAI-compatible base URL */
  baseURL: string
  /** API key for this provider */
  apiKey: string
}

/**
 * Normalize an agent identifier for case-insensitive, hyphen/underscore-agnostic matching.
 */
function normalize(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '')
}

function canonicalModelName(model: string): string {
  const normalized = model.trim().toLowerCase().replace(/\[1m\]$/i, '')
  return normalized.split('/').at(-1) ?? normalized
}

function isAgentModelProfile(value: string): value is AgentModelProfile {
  return Object.hasOwn(AGENT_MODEL_PROFILES, value)
}

export function parseAgentModelProfileReference(
  value: string | undefined,
): AgentModelProfile | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  if (!normalized.startsWith('profile:')) return null
  const candidate = normalized.slice('profile:'.length)
  return isAgentModelProfile(candidate) ? candidate : null
}

function findRoutingValue(
  name: string | undefined,
  subagentType: string | undefined,
  settings: SettingsJson | null,
): NonNullable<SettingsJson['agentRouting']>[string] | undefined {
  const routing = settings?.agentRouting
  if (!routing) return undefined

  const normalizedRouting = new Map<
    string,
    NonNullable<SettingsJson['agentRouting']>[string]
  >()
  for (const [key, value] of Object.entries(routing)) {
    const normalizedKey = normalize(key)
    if (normalizedRouting.has(normalizedKey)) {
      console.error(
        `[agentRouting] Warning: routing key "${key}" collides with an existing key after normalization (both map to "${normalizedKey}"). First entry wins.`,
      )
    }
    if (!normalizedRouting.has(normalizedKey)) {
      normalizedRouting.set(normalizedKey, value)
    }
  }

  for (const candidate of [name, subagentType, 'default'].filter(
    Boolean,
  ) as string[]) {
    const match = normalizedRouting.get(normalize(candidate))
    if (match !== undefined) return match
  }

  return undefined
}

function findAvailableModel(
  requestedModel: string,
  availableModels: readonly VerbooModel[],
): VerbooModel | undefined {
  const exact = availableModels.find(
    model => model.id.toLowerCase() === requestedModel.toLowerCase(),
  )
  if (exact) return exact

  const canonicalRequested = canonicalModelName(requestedModel)
  return availableModels.find(
    model => canonicalModelName(model.id) === canonicalRequested,
  )
}

export function resolveAgentProfileModel(
  profile: AgentModelProfile,
  availableModels: readonly VerbooModel[],
): string | null {
  const selected = AGENT_MODEL_PROFILES[profile]
    .map(candidate => findAvailableModel(candidate, availableModels))
    .find((model): model is VerbooModel => model !== undefined)
  return selected?.id ?? null
}

/**
 * Resolve an agent route against the authenticated Verboo model catalog.
 *
 * String values remain backwards compatible with agentModels. If no external
 * provider exists under that name, known profile names and exact Verboo model
 * IDs are resolved only when present in the account's available model catalog.
 */
export function resolveAgentRoute(
  name: string | undefined,
  subagentType: string | undefined,
  settings: SettingsJson | null,
  availableModels: readonly VerbooModel[] = [],
): ResolvedAgentRoute | null {
  if (!settings) return null

  const routingValue = findRoutingValue(name, subagentType, settings)
  if (routingValue === undefined) {
    const defaultProfile = subagentType
      ? DEFAULT_AGENT_PROFILES[normalize(subagentType)]
      : undefined
    if (!defaultProfile) return null

    const selectedModel = resolveAgentProfileModel(
      defaultProfile,
      availableModels,
    )
    return selectedModel
      ? {
          model: selectedModel,
          source: 'profile',
          profile: defaultProfile,
        }
      : null
  }

  if (typeof routingValue === 'string') {
    const externalModel = settings.agentModels?.[routingValue]
    if (externalModel) {
      const providerOverride = {
        model: routingValue,
        baseURL: externalModel.base_url,
        apiKey: externalModel.api_key,
      }
      return {
        model: routingValue,
        source: 'external-provider',
        providerOverride,
      }
    }

    if (isAgentModelProfile(routingValue)) {
      const selectedModel = resolveAgentProfileModel(
        routingValue,
        availableModels,
      )
      return selectedModel
        ? {
            model: selectedModel,
            source: 'profile',
            profile: routingValue,
          }
        : null
    }

    const selected = findAvailableModel(routingValue, availableModels)
    return selected
      ? { model: selected.id, source: 'verboo-model' }
      : null
  }

  if ('model' in routingValue) {
    const selected = findAvailableModel(routingValue.model, availableModels)
    return selected
      ? { model: selected.id, source: 'verboo-model' }
      : null
  }

  const selectedModel = resolveAgentProfileModel(
    routingValue.profile,
    availableModels,
  )
  if (selectedModel) {
    return {
      model: selectedModel,
      source: 'profile',
      profile: routingValue.profile,
    }
  }

  if (routingValue.fallback === 'first-available' && availableModels[0]) {
    return {
      model: availableModels[0].id,
      source: 'profile',
      profile: routingValue.profile,
    }
  }

  return null
}

/**
 * Look up agent.routing by name or subagent_type, then resolve via agent.models.
 *
 * Priority: name > subagentType > "default" > null (use global provider)
 */
export function resolveAgentProvider(
  name: string | undefined,
  subagentType: string | undefined,
  settings: SettingsJson | null,
): ProviderOverride | null {
  return resolveAgentRoute(name, subagentType, settings)?.providerOverride ?? null
}
