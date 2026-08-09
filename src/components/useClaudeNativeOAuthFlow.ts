import * as React from 'react'

import {
  ClaudeNativeOAuthService,
  type ClaudeNativeOAuthTokens,
} from '../services/api/claudeNativeOAuth.js'
import { CLAUDE_RISK_NOTICE_VERSION } from '../services/api/claudeNativeConfig.js'
import { openBrowser } from '../utils/browser.js'
import {
  saveClaudeNativeCredentials,
  type ClaudeNativeCredentialBlob,
} from '../utils/claudeNativeCredentials.js'
import { isBareMode } from '../utils/envUtils.js'

type FlowState =
  | { state: 'starting' }
  | { state: 'waiting'; authUrl: string; browserOpened: boolean | null }
  | { state: 'error'; message: string }

export type ClaudeNativeOAuthFlowStatus = FlowState & { cancel: () => void }

type PersistCredentials = (options?: {
  reconnectLocalAccountId?: string
}) => ClaudeNativeCredentialBlob

type Dependencies = {
  createOAuthService?: () => Pick<
    ClaudeNativeOAuthService,
    'startOAuthFlow' | 'cleanup'
  >
  openBrowser?: typeof openBrowser
  saveCredentials?: typeof saveClaudeNativeCredentials
  isBareMode?: typeof isBareMode
}

function createDefaultOAuthService() {
  return new ClaudeNativeOAuthService()
}

export function useClaudeNativeOAuthFlow(options: {
  additive?: boolean
  reconnectLocalAccountId?: string
  acceptedAt: string
  onAuthenticated: (
    tokens: ClaudeNativeOAuthTokens,
    persistCredentials: PersistCredentials,
    candidateCredentials: ClaudeNativeCredentialBlob,
  ) => void | Promise<void>
  deps?: Dependencies
}): ClaudeNativeOAuthFlowStatus {
  const createOAuthService =
    options.deps?.createOAuthService ?? createDefaultOAuthService
  const openBrowserFn = options.deps?.openBrowser ?? openBrowser
  const saveCredentials =
    options.deps?.saveCredentials ?? saveClaudeNativeCredentials
  const isBareModeFn = options.deps?.isBareMode ?? isBareMode
  const [status, setStatus] = React.useState<FlowState>({ state: 'starting' })
  const cancelRef = React.useRef<() => void>(() => {})
  const cancel = React.useCallback(() => cancelRef.current(), [])

  React.useEffect(() => {
    if (isBareModeFn()) {
      setStatus({
        state: 'error',
        message:
          'O OAuth Claude não está disponível em --bare porque o armazenamento seguro está desativado.',
      })
      return
    }

    let cancelled = false
    const oauthService = createOAuthService()
    const cancelFlow = () => {
      if (cancelled) return
      cancelled = true
      oauthService.cleanup()
    }
    cancelRef.current = cancelFlow

    void oauthService
      .startOAuthFlow(async authUrl => {
        if (cancelled) return
        setStatus({ state: 'waiting', authUrl, browserOpened: null })
        const browserOpened = await openBrowserFn(authUrl)
        if (cancelled) return
        setStatus({ state: 'waiting', authUrl, browserOpened })
      })
      .then(async tokens => {
        if (cancelled) return
        const candidateCredentials: ClaudeNativeCredentialBlob = {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          scopes: tokens.scopes,
          accountId: tokens.accountId,
          email: tokens.email,
          organizationId: tokens.organizationId,
          riskAcceptance: {
            version: CLAUDE_RISK_NOTICE_VERSION,
            acceptedAt: options.acceptedAt,
            accountId: tokens.accountId,
          },
        }
        const persistCredentials = (persistOptions?: {
          reconnectLocalAccountId?: string
        }): ClaudeNativeCredentialBlob => {
          const localAccountId =
            persistOptions?.reconnectLocalAccountId ?? options.reconnectLocalAccountId
          const saveOptions = options.additive || localAccountId
            ? {
                localAccountId,
                additive: Boolean(options.additive || localAccountId),
              }
            : undefined
          const saved = saveOptions
            ? saveCredentials(candidateCredentials, saveOptions)
            : saveCredentials(candidateCredentials)
          if (!saved.success) {
            throw new Error(
              saved.warning ??
                'O OAuth Claude foi concluído, mas as credenciais não puderam ser salvas com segurança.',
            )
          }
          return candidateCredentials
        }
        await options.onAuthenticated(
          tokens,
          persistCredentials,
          candidateCredentials,
        )
      })
      .catch(error => {
        if (cancelled) return
        setStatus({
          state: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      })

    return () => {
      cancelFlow()
      cancelRef.current = () => {}
    }
  }, [
    options.additive,
    createOAuthService,
    isBareModeFn,
    openBrowserFn,
    options.acceptedAt,
    options.onAuthenticated,
    options.reconnectLocalAccountId,
    saveCredentials,
  ])

  return React.useMemo(() => ({ ...status, cancel }), [cancel, status])
}
