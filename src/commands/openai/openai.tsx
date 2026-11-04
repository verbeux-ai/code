import * as React from 'react'

import TextInput from '../../components/TextInput.js'
import { Box, Text, useInput } from '../../ink.js'
import {
  clearOpenAIApiModelsCache,
  fetchOpenAIApiModels,
  getCachedOpenAIApiModels,
} from '../../services/api/openaiApiModels.js'
import { getCachedVerbooModels } from '../../services/api/verbooModels.js'
import { ensureVerbooAuthenticated } from '../../services/oauth/verbooStartupAuth.js'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import {
  buildOpenAIApiKeyCredential,
  clearOpenAIApiKeyCredential,
  looksLikeOpenAIApiKey,
  readOpenAIApiKeyCredentialAsync,
  saveOpenAIApiKeyCredential,
} from '../../utils/openaiApiKeyCredentials.js'
import { parseProviderLoginArgs } from '../../utils/providerAccounts/loginArgs.js'

type LoginState =
  | { state: 'editing'; error?: string }
  | { state: 'validating' }

/**
 * Connects the user's own OpenAI API key. Requests made with it are billed by
 * OpenAI to that key. The key is validated against the Models API before it
 * is stored, and only ever kept in secure storage.
 */
function OpenAIApiKeyLogin({ onDone }: { onDone: LocalJSXCommandOnDone }) {
  const [value, setValue] = React.useState('')
  const [cursorOffset, setCursorOffset] = React.useState(0)
  const [status, setStatus] = React.useState<LoginState>({ state: 'editing' })

  // The field is masked: nothing shows that a refused entry is still in it, and
  // pasting a corrected key would glue the two together.
  React.useEffect(() => {
    if (status.state === 'editing' && status.error) {
      setValue('')
      setCursorOffset(0)
    }
  }, [status])

  const cancelledRef = React.useRef(false)

  const cancel = React.useCallback(() => {
    cancelledRef.current = true
    onDone('Conexão OpenAI cancelada. O Verboo continua disponível.', {
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
      if (!looksLikeOpenAIApiKey(apiKey)) {
        setStatus({
          state: 'editing',
          error: 'Isso não parece uma chave de API da OpenAI (começa com sk-).',
        })
        return
      }
      setStatus({ state: 'validating' })
      const credential = buildOpenAIApiKeyCredential(apiKey)
      try {
        const models = await fetchOpenAIApiModels({ force: true, credential })
        if (cancelledRef.current) return
        if (models.length === 0) {
          setStatus({
            state: 'editing',
            error: 'A chave foi aceita, mas a OpenAI não retornou nenhum modelo de chat para ela.',
          })
          return
        }
        const saved = saveOpenAIApiKeyCredential(credential)
        if (!saved.success) {
          setStatus({
            state: 'editing',
            error: saved.warning ?? 'Não foi possível salvar a chave no armazenamento seguro.',
          })
          return
        }
        clearOpenAIApiModelsCache()
        await fetchOpenAIApiModels({ force: true }).catch(() => undefined)
        if (cancelledRef.current) return
        onDone(
          `Chave da OpenAI conectada (…${credential.keyHint}). ${models.length} modelo(s) GPT liberado(s), cobrados pela OpenAI na sua chave. Use /model para escolher.`,
          { display: 'system' },
        )
      } catch (error) {
        if (cancelledRef.current) return
        const status = (error as { status?: number }).status
        setStatus({
          state: 'editing',
          error:
            status === 401 || status === 403
              ? 'A OpenAI recusou essa chave. Confira a chave em platform.openai.com.'
              : `Não foi possível validar a chave: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    },
    [onDone],
  )

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="remember">Conectar OpenAI com sua chave de API</Text>
      <Text>
        Cole uma chave de API da OpenAI (platform.openai.com → API keys). O uso dos
        modelos GPT é cobrado pela OpenAI nessa chave. A chave fica somente no
        armazenamento seguro do Verboo Code.
      </Text>
      {status.state === 'validating' ? (
        <Text dimColor>Validando a chave com a OpenAI…</Text>
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
    const credential = await readOpenAIApiKeyCredentialAsync()
    onDone(
      credential
        ? `OpenAI conectada com a chave …${credential.keyHint}.`
        : 'OpenAI não conectada. Use /openai login para conectar sua chave de API.',
      { display: 'system' },
    )
    return
  }

  if (action.action === 'logout') {
    const openaiIds = new Set((getCachedOpenAIApiModels() ?? []).map(model => model.id))
    const result = clearOpenAIApiKeyCredential()
    if (!result.success) {
      onDone(result.warning ?? 'Não foi possível remover a chave OpenAI.', {
        display: 'system',
      })
      return
    }
    clearOpenAIApiModelsCache()
    context.setAppState(prev =>
      prev.mainLoopModel !== null && openaiIds.has(prev.mainLoopModel)
        ? {
            ...prev,
            mainLoopModel: getCachedVerbooModels()?.[0]?.id ?? null,
            mainLoopModelForSession: null,
          }
        : prev,
    )
    onDone('Chave da OpenAI removida. O Verboo continua disponível.', {
      display: 'system',
    })
    return
  }

  if (action.action !== 'login' || action.reconnectLocalAccountId) {
    onDone('Uso: /openai [login|status|logout]', { display: 'system' })
    return
  }
  return <OpenAIApiKeyLogin onDone={onDone} />
}
