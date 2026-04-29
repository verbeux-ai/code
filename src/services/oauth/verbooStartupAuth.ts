import axios from 'axios'

import { runOAuthLoginFlow } from '../../cli/handlers/auth.js'
import {
  getActiveScopes,
  getOauthConfig,
  isVerbooMode,
} from '../../constants/oauth.js'
import { fetchVerbooModels, type VerbooModel } from '../api/verbooModels.js'
import {
  clearOAuthTokenCache,
  getClaudeAIOAuthTokensAsync,
  getOauthAccountInfo,
  saveOAuthTokensIfNeeded,
} from '../../utils/auth.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { refreshOAuthToken, storeOAuthAccountInfo } from './client.js'
import type { OAuthTokens } from './types.js'

export type VerbooSessionResult =
  | { kind: 'ok'; tokens: OAuthTokens; refreshed: boolean }
  | { kind: 'unauthenticated' }
  | { kind: 'degraded'; reason: string }

export type VerbooLoginPreflightResult =
  | {
      kind: 'ready'
      tokens: OAuthTokens
      models: VerbooModel[]
      refreshed: boolean
    }
  | { kind: 'needs-oauth'; reason: 'unauthenticated' | 'no-models' }
  | { kind: 'degraded'; reason: string }

let validated = false

export function isVerbooSessionValidated(): boolean {
  return validated
}

export function resetVerbooSessionValidation(): void {
  validated = false
}

export function markVerbooSessionValidated(): void {
  validated = true
}

type MeResponse = {
  data?: {
    id: string
    email: string
    name: string
    avatarUrl?: string | null
    confirmed: boolean
    isAdmin?: boolean
  }
}

async function callApiMe(
  accessToken: string,
): Promise<{ status: 'ok'; data: MeResponse['data'] } | { status: 'unauthorized' } | { status: 'error'; reason: string }> {
  const endpoint = `${getOauthConfig().BASE_API_URL}/api/me`
  try {
    const response = await axios.get<MeResponse>(endpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 5_000,
      validateStatus: () => true,
    })
    if (response.status === 200 && response.data?.data) {
      return { status: 'ok', data: response.data.data }
    }
    if (response.status === 401 || response.status === 403) {
      return { status: 'unauthorized' }
    }
    return { status: 'error', reason: `HTTP ${response.status}` }
  } catch (err) {
    return { status: 'error', reason: errorMessage(err) }
  }
}

function persistAccount(user: NonNullable<MeResponse['data']>): void {
  storeOAuthAccountInfo({
    accountUuid: user.id,
    emailAddress: user.email,
    organizationUuid: user.id,
    displayName: user.name || undefined,
  })
}

export async function validateVerbooSession(): Promise<VerbooSessionResult> {
  if (!isVerbooMode()) {
    return { kind: 'degraded', reason: 'not in verboo mode' }
  }

  const tokens = await getClaudeAIOAuthTokensAsync()
  if (!tokens?.accessToken) {
    return { kind: 'unauthenticated' }
  }

  let result = await callApiMe(tokens.accessToken)

  if (result.status === 'unauthorized' && tokens.refreshToken) {
    logForDebugging('[VerbooStartup] /api/me returned 401, tentando refresh')
    try {
      const refreshed = await refreshOAuthToken(tokens.refreshToken, {
        scopes: [...getActiveScopes()],
      })
      saveOAuthTokensIfNeeded(refreshed)
      clearOAuthTokenCache()
      result = await callApiMe(refreshed.accessToken)
      if (result.status === 'ok' && result.data) {
        persistAccount(result.data)
        return { kind: 'ok', tokens: refreshed, refreshed: true }
      }
    } catch (err) {
      logError(err as Error)
    }
    return { kind: 'unauthenticated' }
  }

  if (result.status === 'ok') {
    if (!result.data) {
      return { kind: 'degraded', reason: 'empty /api/me payload' }
    }
    if (!getOauthAccountInfo()) {
      persistAccount(result.data)
    }
    return { kind: 'ok', tokens, refreshed: false }
  }

  if (result.status === 'unauthorized') {
    return { kind: 'unauthenticated' }
  }

  // Erro de rede / 5xx: deixar passar com warning para não bloquear startup
  // se a API estiver instável. Se realmente sem token, próxima request 401
  // reativa o fluxo via withOAuth401Retry.
  return { kind: 'degraded', reason: result.reason }
}

export type EnsureAuthOpts = {
  /**
   * Callback para abrir o navegador / mostrar UI durante o fluxo de login.
   * Recebe a URL de autorização. Quando ausente, usa stdout simples.
   */
  onAuthUrl?: (url: string) => void | Promise<void>
}

export async function checkVerbooModels(
  accessToken: string,
): Promise<VerbooModel[]> {
  return fetchVerbooModels(accessToken, { force: true }).catch(err => {
    process.stderr.write(
      `[Verboo] Falha ao carregar modelos: ${(err as Error).message ?? String(err)}\n`,
    )
    return []
  })
}

async function loadAndCheckModels(accessToken: string): Promise<void> {
  const models = await checkVerbooModels(accessToken)
  if (models.length === 0) {
    process.stdout.write(getNoVerbooModelsMessage())
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }
}

export function getNoVerbooModelsMessage(): string {
  return (
    '\n❌ Nenhum modelo disponível na sua conta.\n' +
    '   Adquira acesso em: https://code.verboo.ai\n\n' +
    '   Para trocar de conta, execute: verboo logout\n\n'
  )
}

export async function installVerbooOAuthTokens(
  tokens: OAuthTokens,
): Promise<void> {
  const storage = getSecureStorage()
  const storageData = storage.read() || {}
  const updatedStorageData = { ...storageData }
  delete updatedStorageData.verbooApiKey
  storage.update(updatedStorageData)

  const result = saveOAuthTokensIfNeeded(tokens)
  if (!result.success) {
    throw new Error(result.warning ?? 'Não foi possível salvar a sessão Verboo')
  }
  clearOAuthTokenCache()
}

export async function preflightVerbooLogin(): Promise<VerbooLoginPreflightResult> {
  if (!isVerbooMode()) {
    return { kind: 'degraded', reason: 'not in verboo mode' }
  }

  const session = await validateVerbooSession()
  if (session.kind === 'unauthenticated') {
    return { kind: 'needs-oauth', reason: 'unauthenticated' }
  }
  if (session.kind === 'degraded') {
    return { kind: 'degraded', reason: session.reason }
  }

  const models = await checkVerbooModels(session.tokens.accessToken)
  if (models.length === 0) {
    return { kind: 'needs-oauth', reason: 'no-models' }
  }

  return {
    kind: 'ready',
    tokens: session.tokens,
    models,
    refreshed: session.refreshed,
  }
}

/**
 * Garante que existe uma sessão Verboo válida antes do REPL montar. Em modo
 * não-TTY (ex.: -p headless), lança erro com mensagem clara em vez de abrir
 * navegador.
 */
export async function ensureVerbooAuthenticated(
  opts: EnsureAuthOpts = {},
): Promise<void> {
  if (!isVerbooMode() || validated) return

  const session = await validateVerbooSession()

  if (session.kind === 'ok') {
    validated = true
    await loadAndCheckModels(session.tokens.accessToken)
    return
  }

  if (session.kind === 'degraded') {
    const degradedMsg = `[Verboo] Sessão degradada: ${session.reason}. Continuando com token armazenado.`
    logForDebugging(degradedMsg)
    process.stderr.write(degradedMsg + '\n')
    validated = true
    // Tenta atualizar o cache de modelos mesmo em modo degradado.
    const stored = await getClaudeAIOAuthTokensAsync()
    if (stored?.accessToken) {
      await fetchVerbooModels(stored.accessToken).catch(err => {
        logForDebugging(
          `[VerbooStartup] Falha ao atualizar modelos em modo degradado: ${(err as Error).message}`,
        )
      })
    }
    return
  }

  // unauthenticated → precisa abrir login. Só faz sentido em TTY.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'Não autenticado no Verboo. Execute `verboo /login` em um terminal interativo antes de usar o modo headless.',
    )
  }

  process.stdout.write(
    '\n🔐 Você precisa autenticar para usar o Verboo Code.\n',
  )
  process.stdout.write('Abrindo navegador em code.verboo.ai…\n')

  const onAuthUrl =
    opts.onAuthUrl ??
    ((url: string) => {
      process.stdout.write(`\nCaso o navegador não abra, acesse:\n${url}\n\n`)
    })

  const tokens = await runOAuthLoginFlow({
    loginWithClaudeAi: false,
    onAuthUrl,
  })

  await installVerbooOAuthTokens(tokens)
  await validateVerbooSession()
  process.stdout.write('\n✓ Autenticação concluída.\n\n')

  saveGlobalConfig(current =>
    current.hasCompletedOnboarding
      ? current
      : { ...current, hasCompletedOnboarding: true },
  )

  validated = true

  await loadAndCheckModels(tokens.accessToken)
}
