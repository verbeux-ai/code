import * as React from 'react'

import { useCodexOAuthFlow } from '../../components/useCodexOAuthFlow.js'
import { Box, Text, useInput } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import type { CodexOAuthTokens } from '../../services/api/codexOAuth.js'
import {
  clearCodexModelsCache,
  fetchCodexModels,
  getCachedCodexModels,
} from '../../services/api/codexModels.js'
import { getCachedVerbooModels } from '../../services/api/verbooModels.js'
import { ensureVerbooAuthenticated } from '../../services/oauth/verbooStartupAuth.js'
import type { LocalJSXCommandCall, LocalJSXCommandOnDone } from '../../types/command.js'
import {
  clearCodexCredentials,
} from '../../utils/codexCredentials.js'
import { parseProviderLoginArgs } from '../../utils/providerAccounts/loginArgs.js'
import { listProviderAccountSummaries } from '../../utils/providerAccounts/store.js'
import { formatProviderAccountStatus } from '../../utils/providerAccounts/status.js'

function CodexLogin({
  onDone,
  reconnectLocalAccountId,
}: {
  onDone: LocalJSXCommandOnDone
  reconnectLocalAccountId?: string
}) {
  const handleAuthenticated = React.useCallback(
    async (
      _tokens: CodexOAuthTokens,
      persistCredentials: (options?: { reconnectLocalAccountId?: string }) => void,
    ) => {
      persistCredentials({ reconnectLocalAccountId })
      clearCodexModelsCache()
      const models = await fetchCodexModels({ force: true })
      if (models.length === 0) {
        onDone(
          'Login Codex concluído, mas a API não retornou modelos para esta conta.',
          { display: 'system' },
        )
        return
      }
      onDone(
        `Login Codex concluído. ${models.length} modelo(s) adicional(is) liberado(s). Use /model para escolher.`,
        { display: 'system' },
      )
    },
    [onDone],
  )

  const status = useCodexOAuthFlow({
    additive: true,
    reconnectLocalAccountId,
    onAuthenticated: handleAuthenticated,
  })
  const handleCancel = React.useCallback(() => {
    status.cancel()
    onDone('Login Codex cancelado. O Verboo continua disponível.', {
      display: 'system',
    })
  }, [onDone, status])

  useKeybinding('confirm:no', handleCancel, {
    context: 'Confirmation',
  })
  useInput((input, key, event) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      event.stopImmediatePropagation()
      handleCancel()
    }
  })

  if (status.state === 'error') {
    return <Text color="error">{status.message}</Text>
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="remember">Login Codex</Text>
      <Text>
        Entre com sua conta ChatGPT. As credenciais serão guardadas somente no
        armazenamento seguro do Verboo Code.
      </Text>
      {status.state === 'starting' ? (
        <Text dimColor>Preparando o login no navegador…</Text>
      ) : status.browserOpened === false ? (
        <>
          <Text color="warning">Abra esta URL para continuar:</Text>
          <Text>{status.authUrl}</Text>
        </>
      ) : (
        <>
          <Text dimColor>Conclua o login no navegador.</Text>
          <Text>{status.authUrl}</Text>
        </>
      )}
      <Text dimColor>Pressione Esc ou Ctrl+C para cancelar.</Text>
    </Box>
  )
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  // Defense in depth: even if this command is invoked outside the normal REPL
  // bootstrap, Verboo authentication and subscription validation always run
  // before any Codex credential operation or OAuth browser flow.
  try {
    await ensureVerbooAuthenticated()
  } catch (error) {
    onDone(
      error instanceof Error ? error.message : String(error),
      { display: 'system' },
    )
    return
  }

  const action = parseProviderLoginArgs(args)

  if (action.action === 'status') {
    try {
      onDone(formatProviderAccountStatus('codex', listProviderAccountSummaries()), { display: 'system' })
    } catch {
      onDone('Não foi possível consultar as contas Codex no armazenamento seguro. Tente novamente.', { display: 'system' })
    }
    return
  }

  if (action.action === 'logout') {
    const codexModelIds = new Set(
      (getCachedCodexModels() ?? []).map(model => model.id),
    )
    const result = clearCodexCredentials()
    if (!result.success) {
      onDone(result.warning ?? 'Não foi possível remover o login Codex.', {
        display: 'system',
      })
      return
    }
    clearCodexModelsCache()
    context.setAppState(prev =>
      prev.mainLoopModel !== null && codexModelIds.has(prev.mainLoopModel)
        ? {
            ...prev,
            mainLoopModel: getCachedVerbooModels()?.[0]?.id ?? null,
            mainLoopModelForSession: null,
          }
        : prev,
    )
    onDone('Login Codex removido do armazenamento seguro do Verboo Code.', {
      display: 'system',
    })
    return
  }

  if (action.action !== 'login') {
    onDone('Uso: /codex [login|status|logout]', { display: 'system' })
    return
  }

  return (
    <CodexLogin
      onDone={onDone}
      reconnectLocalAccountId={action.reconnectLocalAccountId}
    />
  )
}
