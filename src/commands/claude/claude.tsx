import * as React from 'react'

import TextInput from '../../components/TextInput.js'
import { Box, Text, useInput } from '../../ink.js'
import {
  clearClaudeNativeModelsCache,
  fetchClaudeNativeModels,
  getCachedClaudeNativeModels,
} from '../../services/api/claudeNativeModels.js'
import { getCachedCodexModels } from '../../services/api/codexModels.js'
import { getCachedVerbooModels } from '../../services/api/verbooModels.js'
import { ensureVerbooAuthenticated } from '../../services/oauth/verbooStartupAuth.js'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import {
  buildClaudeApiKeyCredential,
  clearClaudeNativeCredentials,
  looksLikeAnthropicApiKey,
  readClaudeNativeCredentialsAsync,
  saveClaudeNativeCredentials,
} from '../../utils/claudeNativeCredentials.js'
import { parseProviderLoginArgs } from '../../utils/providerAccounts/loginArgs.js'
import { listProviderAccountSummaries } from '../../utils/providerAccounts/store.js'
import { formatProviderAccountStatus } from '../../utils/providerAccounts/status.js'

type LoginState =
  | { state: 'editing'; error?: string }
  | { state: 'validating' }

/**
 * Connects the user's own Anthropic API key (Console). Requests made with it
 * are billed by Anthropic to that key. The key is validated against the
 * Models API before it is stored, and only ever kept in secure storage.
 */
function ClaudeApiKeyLogin({
  onDone,
}: {
  onDone: LocalJSXCommandOnDone
}) {
  const [value, setValue] = React.useState('')
  const [cursorOffset, setCursorOffset] = React.useState(0)
  const [status, setStatus] = React.useState<LoginState>({ state: 'editing' })

  const cancelledRef = React.useRef(false)

  const cancel = React.useCallback(() => {
    cancelledRef.current = true
    onDone('Conexão Claude cancelada. O Verboo continua disponível.', {
      display: 'system',
    })
  }, [onDone])

  useInput((input, key, event) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      event.stopImmediatePropagation()
      cancel()
    }
  })

  const submit = React.useCallback(
    async (raw: string) => {
      const apiKey = raw.trim()
      if (!looksLikeAnthropicApiKey(apiKey)) {
        setStatus({
          state: 'editing',
          error: 'Isso não parece uma chave de API da Anthropic (começa com sk-ant-).',
        })
        return
      }
      setStatus({ state: 'validating' })
      const credentials = buildClaudeApiKeyCredential(apiKey)
      try {
        // A candidate key never touches the catalog of the key in use: a typo
        // here must not break the working session.
        const models = await fetchClaudeNativeModels({ force: true, credentials })
        if (cancelledRef.current) return
        if (models.length === 0) {
          setStatus({
            state: 'editing',
            error: 'A chave foi aceita, mas a Anthropic não retornou nenhum modelo para ela.',
          })
          return
        }
        const saved = saveClaudeNativeCredentials(credentials)
        if (!saved.success) {
          setStatus({
            state: 'editing',
            error: saved.warning ?? 'Não foi possível salvar a chave no armazenamento seguro.',
          })
          return
        }
        clearClaudeNativeModelsCache()
        await fetchClaudeNativeModels({ force: true }).catch(() => undefined)
        if (cancelledRef.current) return
        onDone(
          `Chave da Anthropic conectada (…${credentials.keyHint}). ${models.length} modelo(s) Claude liberado(s), cobrados pela Anthropic na sua chave. Use /model para escolher.`,
          { display: 'system' },
        )
      } catch (error) {
        if (cancelledRef.current) return
        const status = (error as { status?: number }).status
        setStatus({
          state: 'editing',
          error:
            status === 401 || status === 403
              ? 'A Anthropic recusou essa chave. Confira a chave no Console da Anthropic.'
              : `Não foi possível validar a chave: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    },
    [onDone],
  )

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="remember">Conectar Claude com sua chave de API</Text>
      <Text>
        Cole uma chave de API da Anthropic (console.anthropic.com → API Keys). O
        uso dos modelos Claude é cobrado pela Anthropic nessa chave. A chave fica
        somente no armazenamento seguro do Verboo Code.
      </Text>
      {status.state === 'validating' ? (
        <Text dimColor>Validando a chave com a Anthropic…</Text>
      ) : (
        <Box>
          <Text>Chave: </Text>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={value => void submit(value)}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            columns={60}
            focus={true}
            showCursor={true}
            mask="*"
          />
        </Box>
      )}
      {status.state === 'editing' && status.error ? (
        <Text color="error">{status.error}</Text>
      ) : null}
      <Text dimColor>Enter para confirmar · Esc para cancelar</Text>
    </Box>
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
      const credentials = await readClaudeNativeCredentialsAsync()
      const key = credentials ? ` Chave em uso: …${credentials.keyHint}.` : ''
      onDone(`${status}${key}`, { display: 'system' })
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
      onDone(result.warning ?? 'Não foi possível remover a chave Claude.', {
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
    onDone('Chave da Anthropic removida. O Verboo continua disponível.', {
      display: 'system',
    })
    return
  }

  if (action.action !== 'login') {
    onDone('Uso: /claude [login|status|logout]', { display: 'system' })
    return
  }
  return (
    <ClaudeApiKeyLogin onDone={onDone} />
  )
}
