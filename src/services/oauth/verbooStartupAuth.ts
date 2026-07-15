import axios from 'axios'

import { runOAuthLoginFlow } from '../../cli/handlers/auth.js'
import {
  getActiveScopes,
  getOauthConfig,
  isVerbooMode,
} from '../../constants/oauth.js'
import { clearVerbooModelsCache, fetchVerbooModels, type VerbooModel } from '../api/verbooModels.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
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
import { showNoModelsFlow } from './purchaseFlow.js'
import { showPastDueNotice } from './pastDueFlow.js'

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

export type VerbooModelsCheckResult =
  | { kind: 'available'; models: VerbooModel[] }
  | { kind: 'empty'; models: [] }
  | { kind: 'unavailable'; reason: string; models: [] }

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

  // The startup flow used to validate the access token first and only then
  // attempt a refresh. That leaves every user with an expired access token
  // exposed to a transient /api/me failure, after which /v1/models receives
  // the same stale token. Refresh proactively (the helper is lock-safe across
  // concurrent CLI processes) before making either authenticated request.
  await checkAndRefreshOAuthTokenIfNeeded()

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
): Promise<VerbooModelsCheckResult> {
  try {
    const models = await fetchVerbooModels(accessToken, { force: true })
    if (models.length > 0) {
      return { kind: 'available', models }
    }
    return { kind: 'empty', models: [] }
  } catch (err) {
    return {
      kind: 'unavailable',
      reason: errorMessage(err),
      models: [],
    }
  }
}

export function getVerbooModelsUnavailableMessage(reason: string): string {
  return (
    `Não foi possível verificar os modelos do Verboo: ${reason}.\n` +
    'Sua sessão local foi preservada. Tente novamente em alguns instantes.'
  )
}

async function loadAndCheckModels(accessToken: string): Promise<void> {
  const result = await checkVerbooModels(accessToken)
  if (result.kind === 'available') return
  if (result.kind === 'unavailable') {
    throw new Error(getVerbooModelsUnavailableMessage(result.reason))
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'Nenhum modelo disponível nesta conta. Execute `verboo /login` em um terminal interativo para escolher um plano.',
    )
  }
  const ok = await showNoModelsFlow(accessToken)
  if (ok) {
    // Re-check models after purchase flow
    const refreshed = await checkVerbooModels(accessToken)
    if (refreshed.kind === 'available') return
    if (refreshed.kind === 'unavailable') {
      throw new Error(getVerbooModelsUnavailableMessage(refreshed.reason))
    }
  }
  process.stdout.write(
    '\n  Para trocar de conta, execute: verboo logout\n\n',
  )
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(1)
}

export function getNoVerbooModelsMessage(): string {
  return (
    '\nNenhum modelo disponivel na sua conta.\n' +
    '  Execute verboo novamente para ver os planos disponiveis.\n\n' +
    '  Para trocar de conta, execute: verboo logout\n\n'
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
  if (models.kind === 'unavailable') {
    return { kind: 'degraded', reason: models.reason }
  }
  if (models.kind === 'empty') {
    return { kind: 'needs-oauth', reason: 'no-models' }
  }

  return {
    kind: 'ready',
    tokens: session.tokens,
    models: models.models,
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

  // Sempre buscar modelos frescos a cada restart — sem cache entre sessões.
  clearVerbooModelsCache()

  const session = await validateVerbooSession()

  if (session.kind === 'ok') {
    await loadAndCheckModels(session.tokens.accessToken)
    validated = true
    await showPastDueNotice(session.tokens.accessToken)
    return
  }

  if (session.kind === 'degraded') {
    // A temporary /api/me or router failure must not turn into a startup error
    // for an otherwise valid local session. Keep the diagnostic in the debug
    // log, but never surface it to the user or open the purchase flow.
    logForDebugging(
      `[VerbooStartup] Sessão degradada: ${session.reason}. Preservando sessão local.`,
    )

    // Best effort only: warm the cache if the router is reachable, but do not
    // block the CLI or report a transient verification failure to the user.
    const stored = await getClaudeAIOAuthTokensAsync()
    if (stored?.accessToken) {
      const models = await checkVerbooModels(stored.accessToken)
      if (models.kind === 'unavailable') {
        logForDebugging(
          `[VerbooStartup] Modelos indisponíveis durante sessão degradada: ${models.reason}`,
        )
      }
    }
    validated = true
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
  const confirmedSession = await validateVerbooSession()
  if (confirmedSession.kind === 'unauthenticated') {
    throw new Error(
      'A sessão recém-autenticada foi rejeitada pelo Verboo. Feche variáveis de credencial herdadas do terminal e tente `verboo /login` novamente.',
    )
  }
  process.stdout.write('\n✓ Autenticação concluída.\n\n')

  saveGlobalConfig(current =>
    current.hasCompletedOnboarding
      ? current
      : { ...current, hasCompletedOnboarding: true },
  )

  // In a transient `/api/me` outage, the freshly returned OAuth token can
  // still be valid for inference. The model check below is the authoritative
  // router check and must finish before we mark the session as validated.
  await loadAndCheckModels(
    confirmedSession.kind === 'ok'
      ? confirmedSession.tokens.accessToken
      : tokens.accessToken,
  )
  validated = true
}
