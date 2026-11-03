import chalk from 'chalk'
import * as React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import {
  ModelPicker,
  type ModelPickerDiscoveryState,
} from '../../components/ModelPicker.js'
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../constants/xml.js'
import {
  clearDiscoveryCache,
  getCachedModels,
  isCacheStale,
  parseDurationString,
} from '../../integrations/discoveryCache.js'
import type { ModelCatalogConfig } from '../../integrations/descriptors.js'
import {
  discoverModelsForRoute,
  getDiscoveryCacheKey,
} from '../../integrations/discoveryService.js'
import {
  getRouteDescriptor,
  resolveRouteCredentialValue,
  resolveActiveRouteIdFromEnv,
} from '../../integrations/routeMetadata.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { clearRouterRateLimit } from '../../services/routerRateLimit.js'
import {
  fetchCodexModels,
  getCachedCodexModels,
} from '../../services/api/codexModels.js'
import {
  fetchClaudeNativeModels,
  getCachedClaudeNativeModels,
} from '../../services/api/claudeNativeModels.js'
import {
  fetchVerbooModels,
  getCachedVerbooModels,
} from '../../services/api/verbooModels.js'
import { isVerbooMode } from '../../constants/oauth.js'
import {
  getAdditionalModelOptionsCacheScope,
  resolveProviderRequest,
} from '../../services/api/providerConfig.js'
import type { AppState } from '../../state/AppState.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import type { EffortLevel } from '../../utils/effort.js'
import { isBilledAsExtraUsage } from '../../utils/extraUsage.js'
import {
  clearFastModeCooldown,
  isFastModeAvailable,
  isFastModeEnabled,
  isFastModeSupportedByModel,
} from '../../utils/fastMode.js'
import { MODEL_ALIASES } from '../../utils/model/aliases.js'
import {
  checkOpus1mAccess,
  checkSonnet1mAccess,
} from '../../utils/model/check1mAccess.js'
import type { ModelOption } from '../../utils/model/modelOptions.js'
import { buildRouteCatalogModelOptions, mergeRouteCatalogEntries } from '../../utils/model/routeCatalogOptions.js'
import { discoverOpenAICompatibleModelOptions } from '../../utils/model/openaiModelDiscovery.js'
import {
  getDefaultMainLoopModelSetting,
  isOpus1mMergeEnabled,
  parseUserSpecifiedModel,
  renderDefaultModelSetting,
  saveLastVerbooModel,
} from '../../utils/model/model.js'
import { isModelAllowed } from '../../utils/model/modelAllowlist.js'
import { validateModel } from '../../utils/model/validateModel.js'
import { getLocalOpenAICompatibleProviderLabel } from '../../utils/providerDiscovery.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { parseCustomHeadersEnv } from '../../utils/providerCustomHeaders.js'
import { getClaudeAIOAuthTokensAsync } from '../../utils/auth.js'
import { readCodexCredentialsAsync } from '../../utils/codexCredentials.js'
import { readClaudeNativeCredentialsAsync } from '../../utils/claudeNativeCredentials.js'
import {
  getActiveOpenAIModelOptionsCache,
  getActiveProviderProfile,
  setActiveOpenAIModelOptionsCache,
} from '../../utils/providerProfiles.js'

type ModelDiscoveryContext =
  | {
      kind: 'descriptor'
      autoRefresh: boolean
      canRefresh: boolean
      discoveryState?: ModelPickerDiscoveryState
      optionsOverride: ModelOption[]
      routeId: string
      routeDefaultModel?: string
      routeLabel: string
    }
  | {
      kind: 'legacy-openai'
      autoRefresh: boolean
      canRefresh: boolean
      discoveryState?: ModelPickerDiscoveryState
      routeLabel: string
    }

function renderModelLabel(model: string | null): string {
  const rendered = renderDefaultModelSetting(
    model ?? getDefaultMainLoopModelSetting(),
  )
  return model === null ? `${rendered} (default)` : rendered
}

function getEffectiveModelForRateLimit(
  mainLoopModel: string | null,
  mainLoopModelForSession: string | null,
): string {
  return parseUserSpecifiedModel(
    mainLoopModelForSession ?? mainLoopModel ?? getDefaultMainLoopModelSetting(),
  )
}

function clearRouterRateLimitIfModelChanged(
  currentMainLoopModel: string | null,
  currentMainLoopModelForSession: string | null,
  nextMainLoopModel: string | null,
): void {
  const currentEffectiveModel = getEffectiveModelForRateLimit(
    currentMainLoopModel,
    currentMainLoopModelForSession,
  )
  const nextEffectiveModel = getEffectiveModelForRateLimit(
    nextMainLoopModel,
    null,
  )

  if (currentEffectiveModel !== nextEffectiveModel) {
    clearRouterRateLimit()
  }
}

function haveSameModelOptions(left: ModelOption[], right: ModelOption[]): boolean {
  if (left.length !== right.length) {
    return false
  }

  return left.every((option, index) => {
    const other = right[index]
    return (
      other !== undefined &&
      option.value === other.value &&
      option.label === other.label &&
      option.description === other.description &&
      option.descriptionForModel === other.descriptionForModel
    )
  })
}

function getActiveRouteId(): string | null {
  const activeProfile = getActiveProviderProfile()
  return resolveActiveRouteIdFromEnv(process.env, {
    activeProfileProvider: activeProfile?.provider,
  })
}

function getOpenAIDiscoveryRequestOptions(routeId?: string | null): {
  apiKey?: string
  baseUrl?: string
  headers?: Record<string, string>
} {
  const request = resolveProviderRequest({
    model: process.env.OPENAI_MODEL,
    baseUrl: process.env.OPENAI_BASE_URL,
  })

  return {
    apiKey: resolveRouteCredentialValue({
      routeId,
      baseUrl: request.baseUrl,
      processEnv: process.env,
    }),
    baseUrl: request.baseUrl,
    headers: parseCustomHeadersEnv(process.env.ANTHROPIC_CUSTOM_HEADERS),
  }
}

export function shouldAutoRefreshRouteCatalog(options: {
  catalog: ModelCatalogConfig
  hasCachedModels: boolean
  staticEntryCount: number
  stale: boolean
}): boolean {
  const needsInitialDiscovery =
    !options.hasCachedModels && options.staticEntryCount === 0

  switch (options.catalog.discoveryRefreshMode) {
    case 'manual':
      return needsInitialDiscovery
    case 'on-open':
      return true
    case 'startup':
      return needsInitialDiscovery
    case 'background-if-stale':
    default:
      return options.stale || !options.hasCachedModels
  }
}

async function loadDescriptorDiscoveryContext(
  routeId: string,
): Promise<ModelDiscoveryContext | null> {
  const descriptor = getRouteDescriptor(routeId)
  const catalog = descriptor?.catalog
  if (!descriptor || !catalog) {
    return null
  }

  if (routeId === 'custom') {
    return null
  }

  const routeLabel = descriptor.label
  const routeDefaultModel =
    'defaultModel' in descriptor ? descriptor.defaultModel : undefined
  const staticEntries = catalog.models ?? []
  const trafficRestricted = isEssentialTrafficOnly()
  const canRefresh = Boolean(
    catalog.discovery && catalog.allowManualRefresh && !trafficRestricted,
  )

  if (!catalog.discovery) {
    if (staticEntries.length === 0) {
      return null
    }

    return {
      kind: 'descriptor',
      autoRefresh: false,
      canRefresh,
      optionsOverride: buildRouteCatalogModelOptions(
        routeLabel,
        staticEntries,
        routeDefaultModel,
      ),
      routeId,
      routeDefaultModel,
      routeLabel,
    }
  }

  const ttlMs = parseDurationString(catalog.discoveryCacheTtl ?? 0)
  const discoveryOptions = getOpenAIDiscoveryRequestOptions(routeId)
  const cacheKey = getDiscoveryCacheKey(routeId, discoveryOptions)
  const cached = await getCachedModels(cacheKey, ttlMs, { includeStale: true })
  const stale = await isCacheStale(cacheKey, ttlMs)
  const autoRefresh = shouldAutoRefreshRouteCatalog({
    catalog,
    hasCachedModels: cached !== null,
    staticEntryCount: staticEntries.length,
    stale,
  }) && !trafficRestricted
  const mergedEntries = mergeRouteCatalogEntries(
    staticEntries,
    cached?.models ?? [],
  )

  let discoveryState: ModelPickerDiscoveryState | undefined

  if (cached?.error && mergedEntries.length > 0) {
    discoveryState = {
      message: `Showing cached ${routeLabel} models. Last refresh failed: ${cached.error.message}`,
      tone: 'warning',
    }
  } else if (autoRefresh) {
    discoveryState = {
      message: `Checking ${routeLabel} models…`,
      tone: 'info',
    }
  }

  return {
    kind: 'descriptor',
    autoRefresh,
    canRefresh,
    discoveryState,
    optionsOverride: buildRouteCatalogModelOptions(
      routeLabel,
      mergedEntries,
      routeDefaultModel,
    ),
    routeId,
    routeDefaultModel,
    routeLabel,
  }
}

async function loadModelDiscoveryContext(): Promise<ModelDiscoveryContext | null> {
  const routeId = getActiveRouteId()
  if (routeId && routeId !== 'anthropic') {
    const descriptorContext = await loadDescriptorDiscoveryContext(routeId)
    if (descriptorContext) {
      return descriptorContext
    }
  }

  if (getAdditionalModelOptionsCacheScope()?.startsWith('openai:')) {
    const { baseUrl } = getOpenAIDiscoveryRequestOptions()
    return {
      kind: 'legacy-openai',
      autoRefresh: !isEssentialTrafficOnly(),
      canRefresh: !isEssentialTrafficOnly(),
      routeLabel: getLocalOpenAICompatibleProviderLabel(baseUrl),
    }
  }

  return null
}

function descriptorDiscoveryStateForResult(options: {
  changed: boolean
  manual: boolean
  result: Awaited<ReturnType<typeof discoverModelsForRoute>>
  routeLabel: string
}): ModelPickerDiscoveryState {
  const { changed, manual, result, routeLabel } = options

  if (!result) {
    return {
      message: `Could not load model metadata for ${routeLabel}.`,
      tone: 'error',
    }
  }

  if (result.source === 'stale-cache' && result.error) {
    return {
      message: `Refresh failed for ${routeLabel}. Showing cached models: ${result.error.message}`,
      tone: 'warning',
    }
  }

  if (result.source === 'error' && result.error) {
    return {
      message: `Could not refresh ${routeLabel} models: ${result.error.message}`,
      tone: 'error',
    }
  }

  if (!changed) {
    return {
      message: manual
        ? `No changes found for ${routeLabel}.`
        : `${routeLabel} models are up to date.`,
      tone: 'success',
    }
  }

  return {
    message: manual
      ? `Updated ${routeLabel} models.`
      : `Loaded fresh ${routeLabel} models.`,
    tone: 'success',
  }
}

function legacyDiscoveryStateForOptions(options: {
  changed: boolean
  failed?: boolean
  manual: boolean
  routeLabel: string
}): ModelPickerDiscoveryState {
  const { changed, failed, manual, routeLabel } = options

  if (failed) {
    return {
      message: `Could not refresh ${routeLabel} models.`,
      tone: 'warning',
    }
  }

  if (!changed) {
    return {
      message: manual
        ? `No changes found for ${routeLabel}.`
        : `${routeLabel} models are up to date.`,
      tone: 'success',
    }
  }

  return {
    message: manual
      ? `Updated ${routeLabel} models.`
      : `Loaded fresh ${routeLabel} models.`,
    tone: 'success',
  }
}

function ModelPickerWrapper({
  discoveryContext,
  onDone,
}: {
  discoveryContext: ModelDiscoveryContext | null
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
}) {
  const mainLoopModel = useAppState((s: AppState) => s.mainLoopModel)
  const mainLoopModelForSession = useAppState(
    (s: AppState) => s.mainLoopModelForSession,
  )
  const isFastMode = useAppState((s: AppState) => s.fastMode)
  const setAppState = useSetAppState()
  const [optionsOverride, setOptionsOverride] = React.useState<ModelOption[] | undefined>(
    discoveryContext?.kind === 'descriptor'
      ? discoveryContext.optionsOverride
      : undefined,
  )
  const [discoveryState, setDiscoveryState] =
    React.useState<ModelPickerDiscoveryState | undefined>(
      discoveryContext?.discoveryState,
    )

  const handleCancel = () => {
    logEvent('tengu_model_command_menu', {
      action: 'cancel' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    onDone(`Kept model as ${chalk.bold(renderModelLabel(mainLoopModel))}`, {
      display: 'system',
    })
  }

  const handleSelect = (model: string | null, effort: EffortLevel | undefined) => {
    logEvent('tengu_model_command_menu', {
      action: String(model) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      from_model: String(mainLoopModel) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      to_model: String(model) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    clearRouterRateLimitIfModelChanged(
      mainLoopModel,
      mainLoopModelForSession,
      model,
    )
    setAppState(prev => ({
      ...prev,
      mainLoopModel: model,
      mainLoopModelForSession: null,
    }))

    let message = `Set model to ${chalk.bold(renderModelLabel(model))}`
    if (effort !== undefined) {
      message += ` with ${chalk.bold(effort)} effort`
    }

    let wasFastModeToggledOn: boolean | undefined
    if (isFastModeEnabled()) {
      clearFastModeCooldown()
      if (!isFastModeSupportedByModel(model) && isFastMode) {
        setAppState(prev => ({
          ...prev,
          fastMode: false,
        }))
        wasFastModeToggledOn = false
      } else if (
        isFastModeSupportedByModel(model) &&
        isFastModeAvailable() &&
        isFastMode
      ) {
        message += ' · Fast mode ON'
        wasFastModeToggledOn = true
      }
    }

    if (
      isBilledAsExtraUsage(
        model,
        wasFastModeToggledOn === true,
        isOpus1mMergeEnabled(),
      )
    ) {
      message += ' · Billed as extra usage'
    }
    if (wasFastModeToggledOn === false) {
      message += ' · Fast mode OFF'
    }

    onDone(message)
  }

  async function refreshAvailableModels(manual: boolean): Promise<void> {
    if (!discoveryContext) {
      return
    }

    setDiscoveryState({
      message: manual
        ? `Refreshing ${discoveryContext.routeLabel} models…`
        : `Checking ${discoveryContext.routeLabel} models…`,
      tone: 'info',
    })

    if (discoveryContext.kind === 'descriptor') {
      if (manual) {
        await clearDiscoveryCache(
          getDiscoveryCacheKey(
            discoveryContext.routeId,
            getOpenAIDiscoveryRequestOptions(discoveryContext.routeId),
          ),
        )
      }

      const result = await discoverModelsForRoute(
        discoveryContext.routeId,
        {
          ...getOpenAIDiscoveryRequestOptions(discoveryContext.routeId),
          forceRefresh: true,
        },
      )

      const nextOptions = buildRouteCatalogModelOptions(
        discoveryContext.routeLabel,
        result?.models ?? [],
        discoveryContext.routeDefaultModel,
      )
      const changed = !haveSameModelOptions(optionsOverride ?? [], nextOptions)

      setOptionsOverride(nextOptions)
      setDiscoveryState(
        descriptorDiscoveryStateForResult({
          changed,
          manual,
          result,
          routeLabel: discoveryContext.routeLabel,
        }),
      )
      return
    }

    try {
      const discoveredOptions = await discoverOpenAICompatibleModelOptions()
      const currentOptions = getActiveOpenAIModelOptionsCache()
      const changed =
        discoveredOptions.length > 0 &&
        !haveSameModelOptions(currentOptions, discoveredOptions)

      if (discoveredOptions.length > 0 && changed) {
        setActiveOpenAIModelOptionsCache(discoveredOptions)
      }

      setDiscoveryState(
        legacyDiscoveryStateForOptions({
          changed,
          manual,
          routeLabel: discoveryContext.routeLabel,
        }),
      )
    } catch {
      setDiscoveryState(
        legacyDiscoveryStateForOptions({
          changed: false,
          failed: true,
          manual,
          routeLabel: discoveryContext.routeLabel,
        }),
      )
    }
  }

  React.useEffect(() => {
    if (!discoveryContext?.autoRefresh) {
      return
    }

    void refreshAvailableModels(false)
    // We only want the initial auto-refresh for the loaded context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <ModelPicker
      initial={mainLoopModel}
      sessionModel={mainLoopModelForSession}
      onSelect={handleSelect}
      onCancel={handleCancel}
      isStandaloneCommand
      showFastModeNotice={
        isFastModeEnabled() &&
        isFastMode &&
        isFastModeSupportedByModel(mainLoopModel) &&
        isFastModeAvailable()
      }
      optionsOverride={optionsOverride}
      discoveryState={discoveryState}
      onRefresh={
        discoveryContext?.canRefresh
          ? () => {
              void refreshAvailableModels(true)
            }
          : undefined
      }
    />
  )
}

function SetModelAndClose({
  args,
  onDone,
}: {
  args: string
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
}) {
  const isFastMode = useAppState((s: AppState) => s.fastMode)
  const currentMainLoopModel = useAppState((s: AppState) => s.mainLoopModel)
  const currentMainLoopModelForSession = useAppState(
    (s: AppState) => s.mainLoopModelForSession,
  )
  const initialModelStateRef = React.useRef({
    mainLoopModel: currentMainLoopModel,
    mainLoopModelForSession: currentMainLoopModelForSession,
  })
  const setAppState = useSetAppState()
  const model = args === 'default' ? null : args

  React.useEffect(() => {
    async function handleModelChange(): Promise<void> {
      if (model && !isModelAllowed(model)) {
        onDone(
          `Model '${model}' is not available. Your organization restricts model selection.`,
          {
            display: 'system',
          },
        )
        return
      }

      if (model && isOpus1mUnavailable(model)) {
        onDone(
          'Opus 4.6 with 1M context is not available for your account. Learn more: https://code.claude.com/docs/en/model-config#extended-context-with-1m',
          {
            display: 'system',
          },
        )
        return
      }
      if (model && isSonnet1mUnavailable(model)) {
        onDone(
          'Sonnet 4.6 with 1M context is not available for your account. Learn more: https://code.claude.com/docs/en/model-config#extended-context-with-1m',
          {
            display: 'system',
          },
        )
        return
      }

      if (!model) {
        setModel(null)
        return
      }

      if (isKnownAlias(model)) {
        setModel(model)
        return
      }

      try {
        const { valid, error } = await validateModel(model)
        if (valid) {
          setModel(model)
        } else {
          onDone(error || `Model '${model}' not found`, {
            display: 'system',
          })
        }
      } catch (error) {
        onDone(`Failed to validate model: ${(error as Error).message}`, {
          display: 'system',
        })
      }
    }

    function setModel(modelValue: string | null): void {
      const initialModelState = initialModelStateRef.current
      clearRouterRateLimitIfModelChanged(
        initialModelState.mainLoopModel,
        initialModelState.mainLoopModelForSession,
        modelValue,
      )
      setAppState(prev => ({
        ...prev,
        mainLoopModel: modelValue,
        mainLoopModelForSession: null,
      }))

      let message = `Set model to ${chalk.bold(renderModelLabel(modelValue))}`
      let wasFastModeToggledOn: boolean | undefined

      if (isFastModeEnabled()) {
        clearFastModeCooldown()
        if (!isFastModeSupportedByModel(modelValue) && isFastMode) {
          setAppState(prev => ({
            ...prev,
            fastMode: false,
          }))
          wasFastModeToggledOn = false
        } else if (isFastModeSupportedByModel(modelValue) && isFastMode) {
          message += ' · Fast mode ON'
          wasFastModeToggledOn = true
        }
      }

      if (
        isBilledAsExtraUsage(
          modelValue,
          wasFastModeToggledOn === true,
          isOpus1mMergeEnabled(),
        )
      ) {
        message += ' · Billed as extra usage'
      }
      if (wasFastModeToggledOn === false) {
        message += ' · Fast mode OFF'
      }

      onDone(message)
    }

    void handleModelChange()
  }, [isFastMode, model, onDone, setAppState])

  return null
}

function isKnownAlias(model: string): boolean {
  return (MODEL_ALIASES as readonly string[]).includes(
    model.toLowerCase().trim(),
  )
}

function isOpus1mUnavailable(model: string): boolean {
  const normalized = model.toLowerCase()
  return (
    !checkOpus1mAccess() &&
    !isOpus1mMergeEnabled() &&
    normalized.includes('opus') &&
    normalized.includes('[1m]')
  )
}

function isSonnet1mUnavailable(model: string): boolean {
  const normalized = model.toLowerCase()
  return (
    !checkSonnet1mAccess() &&
    (normalized.includes('sonnet[1m]') ||
      normalized.includes('sonnet-4-6[1m]'))
  )
}

function ShowModelAndClose({
  onDone,
}: {
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
}) {
  const mainLoopModel = useAppState((s: AppState) => s.mainLoopModel)
  const mainLoopModelForSession = useAppState(
    (s: AppState) => s.mainLoopModelForSession,
  )
  const effortValue = useAppState((s: AppState) => s.effortValue)
  const displayModel = renderModelLabel(mainLoopModel)
  const effortInfo =
    effortValue !== undefined ? ` (effort: ${effortValue})` : ''

  if (mainLoopModelForSession) {
    onDone(
      `Current model: ${chalk.bold(renderModelLabel(mainLoopModelForSession))} (session override from plan mode)\nBase model: ${displayModel}${effortInfo}`,
    )
  } else {
    onDone(`Current model: ${displayModel}${effortInfo}`)
  }

  return null
}

type UnlockedModel = {
  id: string
  displayName: string
  description?: string
  contextWindow?: number
  provider: 'verboo' | 'codex' | 'claude'
}

async function loadUnlockedModels(force = false): Promise<UnlockedModel[]> {
  let verboo = getCachedVerbooModels()
  if (force || !verboo) {
    const tokens = await getClaudeAIOAuthTokensAsync()
    if (!tokens?.accessToken) {
      throw new Error('Sessão Verboo ausente. Execute /login.')
    }
    verboo = await fetchVerbooModels(tokens.accessToken, { force })
  }
  const models: UnlockedModel[] = verboo.map(model => ({
    id: model.id,
    displayName: model.displayName ?? model.id,
    description: model.description,
    contextWindow: model.contextWindow,
    provider: 'verboo',
  }))

  const cachedCodex = getCachedCodexModels()
  if (cachedCodex && !force) {
    const seen = new Set(models.map(model => model.id))
    for (const model of cachedCodex) {
      if (!seen.has(model.id)) {
        models.push({ ...model, provider: 'codex' })
        seen.add(model.id)
      }
    }
  } else if (await readCodexCredentialsAsync()) {
    try {
      const codex = await fetchCodexModels({ force })
      const seen = new Set(models.map(model => model.id))
      for (const model of codex) {
        if (!seen.has(model.id)) {
          models.push({ ...model, provider: 'codex' })
          seen.add(model.id)
        }
      }
    } catch {
      // Codex is an optional model expansion. It must never hide or block the
      // regular Verboo catalog when its credentials/API are unavailable.
    }
  }

  const cachedClaude = getCachedClaudeNativeModels()
  if (cachedClaude && !force) {
    const seen = new Set(models.map(model => model.id))
    for (const model of cachedClaude) {
      if (!seen.has(model.id)) {
        models.push({ ...model, provider: 'claude' })
        seen.add(model.id)
      }
    }
  } else if (await readClaudeNativeCredentialsAsync()) {
    try {
      const claude = await fetchClaudeNativeModels({ force })
      const seen = new Set(models.map(model => model.id))
      for (const model of claude) {
        if (!seen.has(model.id)) {
          models.push({ ...model, provider: 'claude' })
          seen.add(model.id)
        }
      }
    } catch {
      // Claude is optional and always lower priority than Verboo and Codex.
    }
  }
  return models
}

function unlockedModelOptions(models: UnlockedModel[]): ModelOption[] {
  return models.map(model => ({
    value: model.id,
    label: model.displayName,
    description: `${
      model.description ??
      (model.contextWindow
        ? `${Math.round(model.contextWindow / 1000)}K context`
        : model.id)
    }${model.provider === 'claude' ? ' · via Claude nativo' : model.provider === 'codex' ? ' · via Codex' : ''}`,
  }))
}

function VerbooModelPicker({
  models,
  onDone,
}: {
  models: UnlockedModel[]
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
}) {
  const mainLoopModel = useAppState((s: AppState) => s.mainLoopModel)
  const mainLoopModelForSession = useAppState(
    (s: AppState) => s.mainLoopModelForSession,
  )
  const setAppState = useSetAppState()
  const initialModel = models.some(model => model.id === mainLoopModel)
    ? mainLoopModel
    : (models[0]?.id ?? null)

  return (
    <ModelPicker
      initial={initialModel}
      sessionModel={mainLoopModelForSession}
      optionsOverride={unlockedModelOptions(models)}
      isStandaloneCommand
      headerText="Modelos disponíveis no Verboo Code"
      onCancel={() => onDone('Modelo mantido.', { display: 'system' })}
      onSelect={model => {
        if (!model || !models.some(candidate => candidate.id === model)) {
          onDone('Selecione um modelo disponível no catálogo.', {
            display: 'system',
          })
          return
        }
        saveLastVerbooModel(model)
        setAppState(prev => ({
          ...prev,
          mainLoopModel: model,
          mainLoopModelForSession: null,
        }))
        onDone(`Modelo alterado para ${chalk.bold(model)}.`)
      }}
    />
  )
}

async function callVerbooModel(
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void,
  context: Parameters<LocalJSXCommandCall>[1],
  trimmedArgs: string,
): Promise<React.ReactNode> {
  if (COMMON_INFO_ARGS.includes(trimmedArgs)) {
    return <ShowModelAndClose onDone={onDone} />
  }
  if (COMMON_HELP_ARGS.includes(trimmedArgs)) {
    onDone(
      'Use /model para listar os modelos liberados, /model refresh para atualizar o catálogo ou /model <id> para selecionar um ID exato. /codex adiciona modelos Codex e /claude conecta sua chave de API da Anthropic para usar modelos Claude.',
      { display: 'system' },
    )
    return
  }
  if (trimmedArgs === 'refresh') {
    try {
      const models = await loadUnlockedModels(true)
      onDone(`Catálogo atualizado: ${models.length} modelo(s).`, {
        display: 'system',
      })
    } catch (error) {
      onDone(`Não foi possível atualizar o catálogo: ${(error as Error).message}`, {
        display: 'system',
      })
    }
    return
  }
  if (trimmedArgs) {
    try {
      const models = await loadUnlockedModels()
      const model = models.find(candidate => candidate.id === trimmedArgs)
      if (!model) {
        throw new Error(
          `O modelo '${trimmedArgs}' não está disponível. Execute /model para escolher um modelo liberado.`,
        )
      }
      const current = context.getAppState()
      clearRouterRateLimitIfModelChanged(
        current.mainLoopModel,
        current.mainLoopModelForSession,
        model.id,
      )
      saveLastVerbooModel(model.id)
      context.setAppState(prev => ({
        ...prev,
        mainLoopModel: model.id,
        mainLoopModelForSession: null,
      }))
      onDone(`Modelo alterado para ${chalk.bold(model.id)}.`)
    } catch (error) {
      onDone((error as Error).message, { display: 'system' })
    }
    return
  }

  try {
    const models = await loadUnlockedModels()
    if (models.length === 0) {
      onDone('Nenhum modelo está disponível para esta conta.', {
        display: 'system',
      })
      return
    }
    return <VerbooModelPicker models={models} onDone={onDone} />
  } catch (error) {
    onDone((error as Error).message, { display: 'system' })
    return
  }
}

async function refreshModelsAndSummarize(): Promise<string> {
  const discoveryContext = await loadModelDiscoveryContext()

  if (!discoveryContext) {
    return 'The active provider does not support runtime model discovery refresh.'
  }

  if (!discoveryContext.canRefresh) {
    return isEssentialTrafficOnly()
      ? 'Model discovery refresh is disabled while nonessential traffic is disabled.'
      : `${discoveryContext.routeLabel} uses a static model catalog; no refresh is needed.`
  }

  if (discoveryContext.kind === 'descriptor') {
    await clearDiscoveryCache(
      getDiscoveryCacheKey(
        discoveryContext.routeId,
        getOpenAIDiscoveryRequestOptions(discoveryContext.routeId),
      ),
    )
    const result = await discoverModelsForRoute(discoveryContext.routeId, {
      ...getOpenAIDiscoveryRequestOptions(discoveryContext.routeId),
      forceRefresh: true,
    })
    const nextOptions = buildRouteCatalogModelOptions(
      discoveryContext.routeLabel,
      result?.models ?? [],
      discoveryContext.routeDefaultModel,
    )
    const changed = !haveSameModelOptions(
      discoveryContext.optionsOverride,
      nextOptions,
    )

    return descriptorDiscoveryStateForResult({
      changed,
      manual: true,
      result,
      routeLabel: discoveryContext.routeLabel,
    }).message
  }

  try {
    const discoveredOptions = await discoverOpenAICompatibleModelOptions()
    const currentOptions = getActiveOpenAIModelOptionsCache()
    const changed =
      discoveredOptions.length > 0 &&
      !haveSameModelOptions(currentOptions, discoveredOptions)

    if (discoveredOptions.length > 0 && changed) {
      setActiveOpenAIModelOptionsCache(discoveredOptions)
    }

    return legacyDiscoveryStateForOptions({
      changed,
      manual: true,
      routeLabel: discoveryContext.routeLabel,
    }).message
  } catch {
    return legacyDiscoveryStateForOptions({
      changed: false,
      failed: true,
      manual: true,
      routeLabel: discoveryContext.routeLabel,
    }).message
  }
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const trimmedArgs = args?.trim() || ''

  if (isVerbooMode()) {
    return callVerbooModel(onDone, context, trimmedArgs)
  }

  if (COMMON_INFO_ARGS.includes(trimmedArgs)) {
    logEvent('tengu_model_command_inline_help', {
      args: trimmedArgs as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return <ShowModelAndClose onDone={onDone} />
  }

  if (COMMON_HELP_ARGS.includes(trimmedArgs)) {
    onDone(
      'Run /model to open the model selection menu, /model refresh to reload provider models, or /model [modelName] to set the model.',
      {
        display: 'system',
      },
    )
    return
  }

  if (trimmedArgs === 'refresh') {
    onDone(await refreshModelsAndSummarize(), {
      display: 'system',
    })
    return
  }

  if (trimmedArgs) {
    logEvent('tengu_model_command_inline', {
      args: trimmedArgs as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return <SetModelAndClose args={trimmedArgs} onDone={onDone} />
  }

  const discoveryContext = await loadModelDiscoveryContext()
  return <ModelPickerWrapper discoveryContext={discoveryContext} onDone={onDone} />
}
