import * as React from 'react'

import { Select } from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { useClaudeNativeOAuthFlow } from '../../components/useClaudeNativeOAuthFlow.js'
import { Box, Text, useInput } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import {
  clearClaudeNativeModelsCache,
  fetchClaudeNativeModels,
  getCachedClaudeNativeModels,
} from '../../services/api/claudeNativeModels.js'
import {
  CLAUDE_CONSUMER_TERMS_URL,
  CLAUDE_LEGAL_URL,
  CLAUDE_RISK_NOTICE_VERSION,
} from '../../services/api/claudeNativeConfig.js'
import { getCachedCodexModels } from '../../services/api/codexModels.js'
import { getCachedVerbooModels } from '../../services/api/verbooModels.js'
import { ensureVerbooAuthenticated } from '../../services/oauth/verbooStartupAuth.js'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import {
  clearClaudeNativeCredentials,
  hasCurrentClaudeRiskAcceptance,
  readClaudeNativeCredentialsAsync,
  type ClaudeNativeCredentialBlob,
} from '../../utils/claudeNativeCredentials.js'
import { parseProviderLoginArgs } from '../../utils/providerAccounts/loginArgs.js'
import { listProviderAccountSummaries } from '../../utils/providerAccounts/store.js'
import { formatProviderAccountStatus } from '../../utils/providerAccounts/status.js'

function ClaudeLogin({
  acceptedAt,
  onDone,
  reconnectLocalAccountId,
}: {
  acceptedAt: string
  onDone: LocalJSXCommandOnDone
  reconnectLocalAccountId?: string
}) {
  const handleAuthenticated = React.useCallback(
    async (
      _tokens: unknown,
      persistCredentials: (options?: { reconnectLocalAccountId?: string }) => void,
      candidateCredentials: ClaudeNativeCredentialBlob,
    ) => {
      clearClaudeNativeModelsCache()
      const models = await fetchClaudeNativeModels({
        force: true,
        credentials: candidateCredentials,
      })
      if (models.length === 0) {
        throw new Error(
          'Login Claude concluído, mas a Models API não retornou modelos para esta conta.',
        )
      }
      try {
        persistCredentials({ reconnectLocalAccountId })
      } catch (error) {
        // Do not leave an in-memory Claude catalog unlocked when secure
        // persistence failed. A failed optional login must not affect Verboo.
        clearClaudeNativeModelsCache()
        throw error
      }
      onDone(
        `Login Claude concluído. ${models.length} modelo(s) adicional(is) liberado(s). O Verboo continua como prioridade; use /model para escolher.`,
        { display: 'system' },
      )
    },
    [onDone],
  )
  const status = useClaudeNativeOAuthFlow({
    additive: true,
    reconnectLocalAccountId,
    acceptedAt,
    onAuthenticated: handleAuthenticated,
  })
  const handleCancel = React.useCallback(() => {
    status.cancel()
    onDone('Login Claude cancelado. O Verboo continua disponível.', {
      display: 'system',
    })
  }, [onDone, status])

  useKeybinding('confirm:no', handleCancel, { context: 'Confirmation' })
  useInput((input, key, event) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      event.stopImmediatePropagation()
      handleCancel()
    }
  })

  if (status.state === 'error') return <Text color="error">{status.message}</Text>
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="remember">Login Claude nativo</Text>
      <Text>
        Entre com sua conta Claude. As credenciais ficam somente no armazenamento
        seguro do Verboo Code.
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

function ClaudeRiskDisclosure({
  onDone,
  reconnectLocalAccountId,
}: {
  onDone: LocalJSXCommandOnDone
  reconnectLocalAccountId?: string
}) {
  const [acceptedAt, setAcceptedAt] = React.useState<string | null>(null)
  if (acceptedAt) {
    return (
      <ClaudeLogin
        acceptedAt={acceptedAt}
        onDone={onDone}
        reconnectLocalAccountId={reconnectLocalAccountId}
      />
    )
  }

  const cancel = () =>
    onDone('Claude não habilitado. O Verboo continua disponível.', {
      display: 'system',
    })

  return (
    <Dialog
      title="Aviso importante sobre o login Claude"
      color="error"
      onCancel={cancel}
    >
      <Box flexDirection="column" gap={1}>
        <Text>
          A Anthropic informa que o OAuth de assinaturas Claude é destinado ao
          Claude Code e a outros aplicativos nativos. Ela não permite que
          terceiros ofereçam login Claude.ai nem roteiem solicitações usando
          credenciais Free, Pro ou Max.
        </Text>
        <Text>
          O Verboo Code não é afiliado nem endossado pela Anthropic. Este uso
          pode deixar de funcionar sem aviso e pode resultar em limitação ou
          suspensão da conta. Prompts, código e resultados de ferramentas serão
          enviados diretamente à Anthropic.
        </Text>
        <Text color="warning">
          O aceite registra apenas sua ciência e não concede permissão da Anthropic.
        </Text>
        <Text dimColor>Política: {CLAUDE_LEGAL_URL}</Text>
        <Text dimColor>Termos: {CLAUDE_CONSUMER_TERMS_URL}</Text>
        <Select
          defaultFocusValue="cancel"
          options={[
            { label: 'Entendo e aceito o risco', value: 'accept' as const },
            { label: 'Cancelar e continuar com o Verboo', value: 'cancel' as const },
          ]}
          onChange={value => {
            if (value === 'accept') setAcceptedAt(new Date().toISOString())
            else cancel()
          }}
          onCancel={cancel}
        />
      </Box>
    </Dialog>
  )
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  try {
    await ensureVerbooAuthenticated()
  } catch (error) {
    onDone(error instanceof Error ? error.message : String(error), {
      display: 'system',
    })
    return
  }

  const action = parseProviderLoginArgs(args)
  if (action.action === 'status') {
    try {
      const accounts = listProviderAccountSummaries()
      const status = formatProviderAccountStatus('claude', accounts)
      if (!accounts.some(account => account.provider === 'claude')) {
        onDone(status, { display: 'system' })
        return
      }
      const credentials = await readClaudeNativeCredentialsAsync()
      const risk = credentials
        ? ` Aceite de risco v${credentials.riskAcceptance.version}${hasCurrentClaudeRiskAcceptance(credentials) ? ' válido' : ' desatualizado'}.`
        : ''
      onDone(`${status}${risk}`, { display: 'system' })
    } catch {
      onDone('Não foi possível consultar as contas Claude no armazenamento seguro. Tente novamente.', { display: 'system' })
    }
    return
  }

  if (action.action === 'logout') {
    const claudeIds = new Set(
      (getCachedClaudeNativeModels() ?? []).map(model => model.id),
    )
    const verbooIds = new Set(
      (getCachedVerbooModels() ?? []).map(model => model.id),
    )
    const codexIds = new Set((getCachedCodexModels() ?? []).map(model => model.id))
    const result = clearClaudeNativeCredentials()
    if (!result.success) {
      onDone(result.warning ?? 'Não foi possível remover o login Claude.', {
        display: 'system',
      })
      return
    }
    clearClaudeNativeModelsCache()
    context.setAppState(prev =>
      prev.mainLoopModel !== null &&
      claudeIds.has(prev.mainLoopModel) &&
      !verbooIds.has(prev.mainLoopModel) &&
      !codexIds.has(prev.mainLoopModel)
        ? {
            ...prev,
            mainLoopModel: getCachedVerbooModels()?.[0]?.id ?? null,
            mainLoopModelForSession: null,
          }
        : prev,
    )
    onDone(
      `Login Claude e aceite de risco v${CLAUDE_RISK_NOTICE_VERSION} removidos. O Verboo continua disponível.`,
      { display: 'system' },
    )
    return
  }

  if (action.action !== 'login') {
    onDone('Uso: /claude [login|status|logout]', { display: 'system' })
    return
  }
  return (
    <ClaudeRiskDisclosure
      onDone={onDone}
      reconnectLocalAccountId={action.reconnectLocalAccountId}
    />
  )
}
