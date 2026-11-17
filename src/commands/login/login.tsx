import { feature } from 'bun:bundle'
import * as React from 'react'

import { resetCostState } from '../../bootstrap/state.js'
import { isVerbooMode } from '../../constants/oauth.js'
import { captureInteractiveProductCheckpoint, observeInteractiveProductLogin, prepareInteractiveProductAnalytics } from '../../services/productAnalytics/runtime.js'
import {
  markVerbooSessionValidated,
  preflightVerbooLogin,
} from '../../services/oauth/verbooStartupAuth.js'
import {
  clearCLIEntitlementCache,
  fetchCLIEntitlement,
} from '../../services/oauth/cliEntitlement.js'
import { PurchaseFlowView } from '../../services/oauth/purchaseFlow.js'
import { getClaudeAIOAuthTokensAsync } from '../../utils/auth.js'
import { getGlobalConfig } from '../../utils/config.js'
import {
  clearTrustedDeviceToken,
  enrollTrustedDevice,
} from '../../bridge/trustedDevice.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import {
  ConsoleOAuthFlow,
  type ConsoleOAuthFlowResult,
} from '../../components/ConsoleOAuthFlow.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { Text } from '../../ink.js'
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js'
import { refreshPolicyLimits } from '../../services/policyLimits/index.js'
import { refreshRemoteManagedSettings } from '../../services/remoteManagedSettings/index.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { stripSignatureBlocks } from '../../utils/messages.js'
import {
  checkAndDisableAutoModeIfNeeded,
  checkAndDisableBypassPermissionsIfNeeded,
  resetAutoModeGateCheck,
  resetBypassPermissionsCheck,
} from '../../utils/permissions/bypassPermissionsKillswitch.js'
import { resetUserCache } from '../../utils/user.js'

type LoginCompletion =
  | ConsoleOAuthFlowResult
  | {
      type: 'cancel'
    }
  | {
      type: 'ready'
      refreshed: boolean
      oauthCompleted?: boolean
    }
  | {
      type: 'unavailable'
      reason: string
    }

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  if (isVerbooMode()) prepareInteractiveProductAnalytics()
  const productCheckpoint = isVerbooMode() ? captureInteractiveProductCheckpoint() : undefined
  return (
    <Login
      onDone={async result => {
        if (result.type === 'cancel') {
          onDone('Login interrupted')
          return
        }

        if (result.type === 'provider-setup') {
          onDone(result.message, { display: 'system' })
          return
        }

        if (result.type === 'unavailable') {
          onDone(`Não foi possível validar a licença Verboo Code: ${result.reason}`, {
            display: 'system',
          })
          return
        }

        const authChanged = result.type !== 'ready' || result.refreshed

        if (!authChanged) {
          if (isVerbooMode()) {
            markVerbooSessionValidated()
          }
          onDone('Sessão já está válida.')
          return
        }

        context.onChangeAPIKey()
        // Signature-bearing blocks (thinking, connector_text) are bound to the
        // API key. Strip them so the new key doesn't reject stale signatures.
        context.setMessages(stripSignatureBlocks)

        // Post-login refresh logic. Keep in sync with onboarding in
        // src/interactiveHelpers.tsx.
        resetCostState()
        void refreshRemoteManagedSettings()
        void refreshPolicyLimits()
        resetUserCache()
        refreshGrowthBookAfterAuthChange()

        // Clear any stale trusted device token from a previous account before
        // re-enrolling to avoid sending the old token while enrollment is
        // in flight.
        clearTrustedDeviceToken()
        void enrollTrustedDevice()

        resetBypassPermissionsCheck()
        const appState = context.getAppState()
        void checkAndDisableBypassPermissionsIfNeeded(
          appState.toolPermissionContext,
          context.setAppState,
        )

        if (feature('TRANSCRIPT_CLASSIFIER')) {
          resetAutoModeGateCheck()
          void checkAndDisableAutoModeIfNeeded(
            appState.toolPermissionContext,
            context.setAppState,
            appState.fastMode,
          )
        }

        context.setAppState(prev => ({
          ...prev,
          authVersion: prev.authVersion + 1,
        }))

        if (isVerbooMode()) {
          markVerbooSessionValidated()
          if (result.type === 'oauth' || (result.type === 'ready' && result.oauthCompleted)) {
            const accountId = getGlobalConfig().oauthAccount?.accountUuid
            const observedAt = Date.now()
            if (accountId) observeInteractiveProductLogin(observedAt, accountId, productCheckpoint)
          }
        }

        onDone(result.type === 'ready' ? 'Sessão renovada.' : 'Login successful')
      }}
    />
  )
}

export function Login(props: {
  onDone: (result: LoginCompletion, mainLoopModel: string) => void
  startingMessage?: string
}): React.ReactNode {
  const mainLoopModel = useMainLoopModel()
  const [preflightDone, setPreflightDone] = React.useState(!isVerbooMode())
  const [postLoginToken, setPostLoginToken] = React.useState<string | null>(null)
  const pendingOAuth = React.useRef(false)

  React.useEffect(() => {
    if (!isVerbooMode()) return
    let cancelled = false
    preflightVerbooLogin()
      .then(result => {
        if (cancelled) return
        if (result.kind === 'ready') {
          props.onDone(
            { type: 'ready', refreshed: result.refreshed },
            mainLoopModel,
          )
          return
        }
        if (result.kind === 'degraded') {
          props.onDone(
            { type: 'unavailable', reason: result.reason },
            mainLoopModel,
          )
          return
        }
        if (result.kind === 'needs-subscription') {
          setPostLoginToken(result.tokens.accessToken)
          setPreflightDone(true)
          return
        }
        setPreflightDone(true)
      })
      .catch(() => {
        if (!cancelled) setPreflightDone(true)
      })
    return () => {
      cancelled = true
    }
  }, [mainLoopModel, props])

  const handleOAuthDone = React.useCallback(
    async (result?: ConsoleOAuthFlowResult) => {
      if (!result) {
        props.onDone({ type: 'cancel' }, mainLoopModel)
        return
      }

      if (isVerbooMode()) {
        const storedTokens = await getClaudeAIOAuthTokensAsync()
        if (storedTokens?.accessToken) {
          clearCLIEntitlementCache()
          let entitlement
          try {
            entitlement = await fetchCLIEntitlement({ force: true })
          } catch (error) {
            props.onDone(
              {
                type: 'unavailable',
                reason: error instanceof Error ? error.message : String(error),
              },
              mainLoopModel,
            )
            return
          }
          if (!entitlement.allowed) {
            pendingOAuth.current = result.type === 'oauth'
            setPostLoginToken(storedTokens.accessToken)
            return
          }
          markVerbooSessionValidated()
        }
      }

      props.onDone(result ?? { type: 'cancel' }, mainLoopModel)
    },
    [mainLoopModel, props],
  )

  const handlePurchaseDone = React.useCallback(
    async (success: boolean) => {
      if (success && postLoginToken) {
        clearCLIEntitlementCache()
        let entitlement
        try {
          entitlement = await fetchCLIEntitlement({ force: true })
        } catch (error) {
          props.onDone(
            {
              type: 'unavailable',
              reason: error instanceof Error ? error.message : String(error),
            },
            mainLoopModel,
          )
          return
        }
        if (entitlement.allowed) {
          markVerbooSessionValidated()
          props.onDone({ type: 'ready', refreshed: true, oauthCompleted: pendingOAuth.current }, mainLoopModel)
          return
        }
      }
      props.onDone({ type: 'cancel' }, mainLoopModel)
    },
    [postLoginToken, mainLoopModel, props],
  )

  if (!preflightDone) {
    return <Text>Validando sessão Verboo…</Text>
  }

  if (postLoginToken) {
    return (
      <Dialog
        title="Planos Disponiveis"
        onCancel={() => props.onDone({ type: 'cancel' }, mainLoopModel)}
        color="permission"
      >
        <PurchaseFlowView
          accessToken={postLoginToken}
          onDone={handlePurchaseDone}
        />
      </Dialog>
    )
  }

  return (
    <Dialog
      title="Login"
      onCancel={() => props.onDone({ type: 'cancel' }, mainLoopModel)}
      color="permission"
      inputGuide={exitState =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} again to exit</Text>
        ) : (
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description="cancel"
          />
        )
      }
    >
      <ConsoleOAuthFlow
        onDone={handleOAuthDone}
        startingMessage={props.startingMessage}
      />
    </Dialog>
  )
}
