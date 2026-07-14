import * as React from 'react'
import { clearTrustedDeviceTokenCache } from '../../bridge/trustedDevice.js'
import { Text } from '../../ink.js'
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js'
import {
  getGroveNoticeConfig,
  getGroveSettings,
} from '../../services/api/grove.js'
import { clearPolicyLimitsCache } from '../../services/policyLimits/index.js'
import { clearRemoteManagedSettingsCache } from '../../services/remoteManagedSettings/index.js'
import { isVerbooMode } from '../../constants/oauth.js'
import { clearVerbooModelsCache } from '../../services/api/verbooModels.js'
import { resetVerbooSessionValidation } from '../../services/oauth/verbooStartupAuth.js'
import { revokeVerbooRefreshToken } from '../../services/oauth/client.js'
import {
  getAuthTokenSource,
  getClaudeAIOAuthTokens,
  removeApiKey,
} from '../../utils/auth.js'
import { clearBetasCaches } from '../../utils/betas.js'
import { saveGlobalConfig } from '../../utils/config.js'
import { gracefulShutdownSync } from '../../utils/gracefulShutdown.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { clearToolSchemaCache } from '../../utils/toolSchemaCache.js'
import { resetUserCache } from '../../utils/user.js'
import { removeStoredVerbooOauth } from './logoutState.js'
export type LogoutResult = {
  localCleared: boolean
  remoteRevocation: 'revoked' | 'unconfirmed' | 'not_applicable'
  externalTokenSource?: string
}

function isExternallyInjectedTokenSource(source: string): boolean {
  return [
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
    'CCR_OAUTH_TOKEN_FILE',
    'ANTHROPIC_AUTH_TOKEN',
  ].includes(source)
}

export async function performLogout({
  clearOnboarding = false,
}): Promise<LogoutResult> {
  const authTokenSource = getAuthTokenSource().source
  const refreshToken = removeStoredVerbooOauth(getSecureStorage())
  const remoteRevocation = refreshToken
    ? (await revokeVerbooRefreshToken(refreshToken))
      ? ('revoked' as const)
      : ('unconfirmed' as const)
    : ('not_applicable' as const)

  // Verboo does not use the generic Anthropic API-key slot. Preserve it and
  // credentials for MCP, Codex, and plugins when the user signs out of Verboo.
  if (!isVerbooMode()) {
    await removeApiKey()
  }

  if (isVerbooMode()) {
    resetVerbooSessionValidation()
    clearVerbooModelsCache()
  }

  await clearAuthRelatedCaches()
  saveGlobalConfig((current) => {
    const updated = {
      ...current,
    }
    if (clearOnboarding) {
      updated.hasCompletedOnboarding = false
      updated.subscriptionNoticeCount = 0
      updated.hasAvailableSubscription = false
      if (updated.customApiKeyResponses?.approved) {
        updated.customApiKeyResponses = {
          ...updated.customApiKeyResponses,
          approved: [],
        }
      }
    }
    updated.oauthAccount = undefined
    return updated
  })

  return {
    localCleared: true,
    remoteRevocation,
    ...(isExternallyInjectedTokenSource(authTokenSource)
      ? { externalTokenSource: authTokenSource }
      : {}),
  }
}

// clearing anything memoized that must be invalidated when user/session/auth changes
export async function clearAuthRelatedCaches(): Promise<void> {
  // Clear the OAuth token cache
  getClaudeAIOAuthTokens.cache?.clear?.()
  clearTrustedDeviceTokenCache()
  clearBetasCaches()
  clearToolSchemaCache()

  // Clear user data cache BEFORE GrowthBook refresh so it picks up fresh credentials
  resetUserCache()
  refreshGrowthBookAfterAuthChange()

  // Clear Grove config cache
  getGroveNoticeConfig.cache?.clear?.()
  getGroveSettings.cache?.clear?.()

  // Clear remotely managed settings cache
  await clearRemoteManagedSettingsCache()

  // Clear policy limits cache
  await clearPolicyLimitsCache()
}
export async function call(): Promise<React.ReactNode> {
  const result = await performLogout({
    clearOnboarding: true,
  })
  const message = isVerbooMode() ? (
    <Text>
      Saiu da conta Verboo localmente.
      {result.remoteRevocation === 'unconfirmed'
        ? ' Não foi possível confirmar a revogação da sessão no servidor.'
        : ''}
      {result.externalTokenSource
        ? ` ${result.externalTokenSource} ainda fornece uma credencial neste ambiente.`
        : ''}
    </Text>
  ) : (
    <Text>Successfully logged out from your Anthropic account.</Text>
  )
  setTimeout(() => {
    gracefulShutdownSync(0, 'logout')
  }, 200)
  return message
}
