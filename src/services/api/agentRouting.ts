import type { SettingsJson } from '../../utils/settings/types.js'
import { isVerbooMode } from '../../constants/oauth.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import {
  checkIsClaudeNativeProvider,
  getAgentModel,
} from '../../utils/model/agent.js'
import { getRuntimeMainLoopModel } from '../../utils/model/model.js'
import {
  getCachedVerbooModels,
  getVerbooAgentModelForRole,
  type VerbooModel,
  type VerbooAgentModelRole,
} from './verbooModels.js'
import {
  findAvailableAgentModel,
  parseAgentModelProfileReference,
  resolveAgentProfileModel,
  type AgentModelProfile,
} from './agentModelProfiles.js'

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

export type AgentModelResolutionSource =
  | 'external_route'
  | 'environment'
  | 'tool_override'
  | 'catalog_role'
  | 'catalog_profile'
  | 'catalog_model'
  | 'agent_definition'
  | 'parent_fallback'

export type AgentModelResolution = {
  effectiveModel: string
  requestedModel?: string
  source: AgentModelResolutionSource
  providerOverride: ProviderOverride | null
  catalogRole?: VerbooAgentModelRole
  profile?: AgentModelProfile
  fallbackReason?:
    | 'missing_catalog_role'
    | 'missing_catalog_profile'
    | 'missing_catalog_model'
    | 'unsupported_provider_alias'
}

export interface ResolvedAgentRoute {
  model: string
  source: 'external-provider' | 'profile' | 'verboo-model'
  profile?: AgentModelProfile
  providerOverride?: ProviderOverride
}

/**
 * Normalize an agent identifier for case-insensitive, hyphen/underscore-agnostic matching.
 */
function normalize(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '')
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

/** Resolve settings routing against external providers or the Verboo catalog. */
export function resolveAgentRoute(
  name: string | undefined,
  subagentType: string | undefined,
  settings: SettingsJson | null,
  availableModels: readonly VerbooModel[] = getCachedVerbooModels() ?? [],
): ResolvedAgentRoute | null {
  if (!settings) return null
  const routingValue = findRoutingValue(name, subagentType, settings)
  if (routingValue === undefined) return null

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

    const profile = parseAgentModelProfileReference(`profile:${routingValue}`)
    if (profile) {
      const model = resolveAgentProfileModel(profile, availableModels)
      return model ? { model, source: 'profile', profile } : null
    }

    const model = findAvailableAgentModel(routingValue, availableModels)
    return model ? { model: model.id, source: 'verboo-model' } : null
  }

  if ('model' in routingValue) {
    const model = findAvailableAgentModel(routingValue.model, availableModels)
    return model ? { model: model.id, source: 'verboo-model' } : null
  }

  const model = resolveAgentProfileModel(
    routingValue.profile,
    availableModels,
  )
  if (model) {
    return {
      model,
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

const VERBOO_ALIAS_ROLES: Partial<Record<string, VerbooAgentModelRole>> = {
  haiku: 'fast',
  sonnet: 'balanced',
  opus: 'powerful',
}

function resolveParentModel(
  parentModel: string,
  permissionMode: PermissionMode | undefined,
): string {
  return getRuntimeMainLoopModel({
    permissionMode: permissionMode ?? 'default',
    mainLoopModel: parentModel,
    exceeds200kTokens: false,
  })
}

/**
 * Resolves the complete agent route once so the prompt, API request, UI and
 * analytics all observe the same effective model.
 */
export function resolveAgentExecutionModel({
  agentModel,
  agentModelRole,
  parentModel,
  toolSpecifiedModel,
  permissionMode,
  agentName,
  agentType,
  settings,
}: {
  agentModel: string | undefined
  agentModelRole?: VerbooAgentModelRole
  parentModel: string
  toolSpecifiedModel?: string
  permissionMode?: PermissionMode
  agentName?: string
  agentType?: string
  settings: SettingsJson | null
}): AgentModelResolution {
  const configuredRoutingValue = findRoutingValue(
    agentName,
    agentType,
    settings,
  )
  const configuredRoute = resolveAgentRoute(agentName, agentType, settings)
  if (configuredRoute) {
    return {
      effectiveModel: configuredRoute.model,
      requestedModel: configuredRoute.model,
      source:
        configuredRoute.source === 'external-provider'
          ? 'external_route'
          : configuredRoute.source === 'profile'
            ? 'catalog_profile'
            : 'catalog_model',
      providerOverride: configuredRoute.providerOverride ?? null,
      profile: configuredRoute.profile,
    }
  }

  const configuredProfile =
    typeof configuredRoutingValue === 'string'
      ? parseAgentModelProfileReference(`profile:${configuredRoutingValue}`)
      : configuredRoutingValue && 'profile' in configuredRoutingValue
        ? configuredRoutingValue.profile
        : null
  const configuredModel =
    configuredRoutingValue &&
    typeof configuredRoutingValue !== 'string' &&
    'model' in configuredRoutingValue
      ? configuredRoutingValue.model
      : undefined
  if (configuredProfile || configuredModel) {
    return {
      effectiveModel: resolveParentModel(parentModel, permissionMode),
      requestedModel:
        configuredModel ??
        (configuredProfile ? `profile:${configuredProfile}` : undefined),
      source: 'parent_fallback',
      providerOverride: null,
      ...(configuredProfile && { profile: configuredProfile }),
      fallbackReason: configuredProfile
        ? 'missing_catalog_profile'
        : 'missing_catalog_model',
    }
  }

  const environmentModel = process.env.CLAUDE_CODE_SUBAGENT_MODEL?.trim()
  const requestedModel = environmentModel || toolSpecifiedModel || agentModel
  const requestedSource: AgentModelResolutionSource = environmentModel
    ? 'environment'
    : toolSpecifiedModel
      ? 'tool_override'
      : 'agent_definition'

  if (isVerbooMode()) {
    const normalizedRequested = requestedModel?.trim().toLowerCase()
    const availableModels = getCachedVerbooModels() ?? []
    const requestedProfile = parseAgentModelProfileReference(requestedModel)
    if (requestedProfile) {
      const profileModel = resolveAgentProfileModel(
        requestedProfile,
        availableModels,
      )
      if (profileModel) {
        return {
          effectiveModel: profileModel,
          requestedModel,
          source: 'catalog_profile',
          providerOverride: null,
          profile: requestedProfile,
        }
      }
      return {
        effectiveModel: resolveParentModel(parentModel, permissionMode),
        requestedModel,
        source: 'parent_fallback',
        providerOverride: null,
        profile: requestedProfile,
        fallbackReason: 'missing_catalog_profile',
      }
    }

    const catalogRole = agentModelRole
      ? agentType?.toLowerCase() === 'explore' &&
        (!normalizedRequested || normalizedRequested === 'haiku')
        ? agentModelRole
        : normalizedRequested
          ? VERBOO_ALIAS_ROLES[normalizedRequested]
          : agentModelRole
      : undefined

    if (catalogRole) {
      const catalogModel = getVerbooAgentModelForRole(catalogRole)
      if (catalogModel) {
        return {
          effectiveModel: catalogModel,
          requestedModel,
          source: 'catalog_role',
          providerOverride: null,
          catalogRole,
        }
      }
      if (catalogRole === 'explore') {
        const compatibleFastModel = resolveAgentProfileModel(
          'fast',
          availableModels,
        )
        if (compatibleFastModel) {
          return {
            effectiveModel: compatibleFastModel,
            requestedModel,
            source: 'catalog_profile',
            providerOverride: null,
            catalogRole,
            profile: 'fast',
          }
        }
      }
      return {
        effectiveModel: resolveParentModel(parentModel, permissionMode),
        requestedModel,
        source: 'parent_fallback',
        providerOverride: null,
        catalogRole,
        fallbackReason: 'missing_catalog_role',
      }
    }

    if (
      normalizedRequested &&
      normalizedRequested !== 'inherit' &&
      VERBOO_ALIAS_ROLES[normalizedRequested] === undefined
    ) {
      const catalogModel = findAvailableAgentModel(
        requestedModel!,
        availableModels,
      )
      if (catalogModel) {
        return {
          effectiveModel: catalogModel.id,
          requestedModel,
          source: 'catalog_model',
          providerOverride: null,
        }
      }
      if (availableModels.length > 0) {
        return {
          effectiveModel: resolveParentModel(parentModel, permissionMode),
          requestedModel,
          source: 'parent_fallback',
          providerOverride: null,
          fallbackReason: 'missing_catalog_model',
        }
      }
    }
  }

  const effectiveModel = getAgentModel(
    agentModel,
    parentModel,
    toolSpecifiedModel,
    permissionMode,
  )
  const normalizedRequested = requestedModel?.trim().toLowerCase()
  const unsupportedProviderAlias =
    normalizedRequested !== undefined &&
    VERBOO_ALIAS_ROLES[normalizedRequested] !== undefined &&
    !checkIsClaudeNativeProvider() &&
    effectiveModel === resolveParentModel(parentModel, permissionMode)

  return {
    effectiveModel,
    requestedModel,
    source: unsupportedProviderAlias ? 'parent_fallback' : requestedSource,
    providerOverride: null,
    ...(unsupportedProviderAlias && {
      fallbackReason: 'unsupported_provider_alias' as const,
    }),
  }
}
