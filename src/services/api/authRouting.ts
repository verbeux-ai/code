import {
  type APIProvider,
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from 'src/utils/model/providers.js'

export type ProviderOverride = {
  model: string
  baseURL: string
  apiKey: string
  /** Opaque local account selected for this process, when using provider OAuth. */
  localAccountId?: string
}

export function shouldUseFirstPartyAnthropicAuthForProvider({
  providerOverride,
  apiProvider,
  isFirstPartyBaseUrl,
}: {
  providerOverride?: ProviderOverride
  apiProvider: APIProvider
  isFirstPartyBaseUrl: boolean
}): boolean {
  return !providerOverride && apiProvider === 'firstParty' && isFirstPartyBaseUrl
}

export function shouldUseFirstPartyAnthropicAuth(
  providerOverride?: ProviderOverride,
): boolean {
  return shouldUseFirstPartyAnthropicAuthForProvider({
    providerOverride,
    apiProvider: getAPIProvider(),
    isFirstPartyBaseUrl: isFirstPartyAnthropicBaseUrl(),
  })
}
