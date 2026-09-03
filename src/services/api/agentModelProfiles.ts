import type { VerbooModel } from './verbooModels.js'

export const AGENT_MODEL_PROFILES = {
  fast: [
    'deepseek-v4-flash',
    'deepseek-v4-flash-0731',
    'glm-5.3-flash',
    'mimo-v2.5',
    'qwen3.6-27b',
    'qwen3.8-27b',
    'minimax-m3',
    'mimo-v2.5-pro',
    'deepseek-v4-pro',
    'deepseek-v4-pro-0813',
    'kimi-k2.7',
    'glm-5.2',
  ],
  review: [
    'deepseek-v4-pro',
    'deepseek-v4-pro-0813',
    'mimo-v2.5-pro',
    'glm-5.2',
    'kimi-k2.7',
    'qwen3.8-27b',
    'qwen3.6-27b',
    'minimax-m3',
    'mimo-v2.5',
    'deepseek-v4-flash-0731',
    'deepseek-v4-flash',
    'glm-5.3-flash',
  ],
  coding: [
    'mimo-v2.5-pro',
    'deepseek-v4-pro',
    'deepseek-v4-pro-0813',
    'qwen3.8-27b',
    'glm-5.2',
    'kimi-k2.7',
    'qwen3.6-27b',
    'minimax-m3',
    'mimo-v2.5',
    'deepseek-v4-flash-0731',
    'deepseek-v4-flash',
    'glm-5.3-flash',
  ],
  testing: [
    'qwen3.6-27b',
    'qwen3.8-27b',
    'deepseek-v4-pro',
    'deepseek-v4-pro-0813',
    'mimo-v2.5-pro',
    'mimo-v2.5',
    'minimax-m3',
    'deepseek-v4-flash-0731',
    'deepseek-v4-flash',
    'glm-5.2',
    'kimi-k2.7',
    'glm-5.3-flash',
  ],
  balanced: [
    'mimo-v2.5',
    'qwen3.6-27b',
    'qwen3.8-27b',
    'minimax-m3',
    'deepseek-v4-flash',
    'deepseek-v4-flash-0731',
    'glm-5.3-flash',
    'mimo-v2.5-pro',
    'deepseek-v4-pro',
    'deepseek-v4-pro-0813',
    'kimi-k2.7',
    'glm-5.2',
  ],
} as const

export type AgentModelProfile = keyof typeof AGENT_MODEL_PROFILES

function canonicalModelName(model: string): string {
  const normalized = model.trim().toLowerCase().replace(/\[1m\]$/i, '')
  return normalized.split('/').at(-1) ?? normalized
}

export function findAvailableAgentModel(
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

/**
 * The router-provided role is authoritative when available. Static preference
 * lists are a compatibility fallback for routers that do not advertise roles.
 */
export function resolveAgentProfileModel(
  profile: AgentModelProfile,
  availableModels: readonly VerbooModel[],
  routerRoleModel?: string,
): string | null {
  if (routerRoleModel) {
    const entitledRoleModel = findAvailableAgentModel(
      routerRoleModel,
      availableModels,
    )
    if (entitledRoleModel) return entitledRoleModel.id
  }

  const selected = AGENT_MODEL_PROFILES[profile]
    .map(candidate => findAvailableAgentModel(candidate, availableModels))
    .find((model): model is VerbooModel => model !== undefined)
  return selected?.id ?? null
}
