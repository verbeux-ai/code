import * as React from 'react'

import {
  CodexOAuthService,
  type CodexOAuthTokens,
} from '../services/api/codexOAuth.js'
import { openBrowser } from '../utils/browser.js'
import { saveCodexCredentials } from '../utils/codexCredentials.js'
import { isBareMode } from '../utils/envUtils.js'

type CodexOAuthFlowState =
  | { state: 'starting' }
  | {
      state: 'waiting'
      authUrl: string
      browserOpened: boolean | null
    }
  | {
      state: 'error'
      message: string
    }

export type CodexOAuthFlowStatus = CodexOAuthFlowState & {
  cancel: () => void
}

type PersistCodexOAuthCredentials = (options?: {
  profileId?: string
  reconnectLocalAccountId?: string
}) => void

type CodexOAuthFlowDependencies = {
  createOAuthService?: () => Pick<
    CodexOAuthService,
    'startOAuthFlow' | 'cleanup'
  >
  openBrowser?: typeof openBrowser
  saveCodexCredentials?: typeof saveCodexCredentials
  isBareMode?: typeof isBareMode
}

function createDefaultOAuthService(): Pick<
  CodexOAuthService,
  'startOAuthFlow' | 'cleanup'
> {
  return new CodexOAuthService()
}

export function useCodexOAuthFlow(options: {
  additive?: boolean
  reconnectLocalAccountId?: string
  onAuthenticated: (
    tokens: CodexOAuthTokens,
    persistCredentials: PersistCodexOAuthCredentials,
  ) => void | Promise<void>
  deps?: CodexOAuthFlowDependencies
}): CodexOAuthFlowStatus {
  const { onAuthenticated } = options
  const createOAuthService =
    options.deps?.createOAuthService ?? createDefaultOAuthService
  const openBrowserFn = options.deps?.openBrowser ?? openBrowser
  const saveCredentials =
    options.deps?.saveCodexCredentials ?? saveCodexCredentials
  const isBareModeFn = options.deps?.isBareMode ?? isBareMode
  const [status, setStatus] = React.useState<CodexOAuthFlowState>({
    state: 'starting',
  })
  const cancelRef = React.useRef<() => void>(() => {})
  const cancel = React.useCallback(() => cancelRef.current(), [])

  React.useEffect(() => {
    if (isBareModeFn()) {
      cancelRef.current = () => {}
      setStatus({
        state: 'error',
        message:
          'Codex OAuth is unavailable in --bare because secure storage is disabled.',
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
        setStatus({
          state: 'waiting',
          authUrl,
          browserOpened: null,
        })
        const browserOpened = await openBrowserFn(authUrl)
        if (cancelled) return
        setStatus({
          state: 'waiting',
          authUrl,
          browserOpened,
        })
      })
      .then(async tokens => {
        if (cancelled) return

        const persistCredentials: PersistCodexOAuthCredentials = persistOptions => {
          const localAccountId =
            persistOptions?.reconnectLocalAccountId ?? options.reconnectLocalAccountId
          const saveOptions = options.additive || localAccountId
            ? {
                localAccountId,
                additive: Boolean(options.additive || localAccountId),
              }
            : undefined
          const credentials = {
            apiKey: tokens.apiKey,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            idToken: tokens.idToken,
            accountId: tokens.accountId,
            profileId: persistOptions?.profileId,
          }
          const saved = saveOptions
            ? saveCredentials(credentials, saveOptions)
            : saveCredentials(credentials)
          if (!saved.success) {
            throw new Error(
              saved.warning ??
                'Codex OAuth succeeded, but credentials could not be saved securely.',
            )
          }
        }

        await onAuthenticated(tokens, persistCredentials)
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
    onAuthenticated,
    openBrowserFn,
    options.reconnectLocalAccountId,
    saveCredentials,
  ])

  return React.useMemo(() => ({ ...status, cancel }), [cancel, status])
}
