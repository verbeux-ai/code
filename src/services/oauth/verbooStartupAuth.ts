import axios from 'axios'

import { runOAuthLoginFlow } from '../../cli/handlers/auth.js'
import {
  getActiveScopes,
  getOauthConfig,
  isVerbooMode,
} from '../../constants/oauth.js'
import {
  clearVerbooModelsCache,
  fetchVerbooModels,
  type VerbooModel,
} from '../api/verbooModels.js'
import { fetchSubscriptions } from '../api/verbooSubscriptions.js'
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
import { showVerbooTermsAcceptance } from '../../components/VerbooTermsAcceptance.js'
import {
  fetchVerbooTermsStatus,
  formatTermsDeadline,
  getHeadlessTermsRequiredMessage,
  getPublicTermsURL,
} from './verbooTerms.js'

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
): Promise<
  | { status: 'ok'; data: MeResponse['data'] }
  | { status: 'unauthorized' }
  | { status: 'error'; reason: string }
> {
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

  // An active grant with no router models is a provisioning delay, not an
  // invitation to buy the same plan again. Give propagation a short window
  // and fail with a specific recovery message instead of opening the catalog.
  const subscriptions = await fetchSubscriptions(accessToken)
  const hasCurrentEntitlement = subscriptions.some(
    (subscription) =>
      subscription.status === 'active' || subscription.status === 'trialing',
  )
  if (hasCurrentEntitlement) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      const refreshed = await checkVerbooModels(accessToken)
      if (refreshed.kind === 'available') return
      if (refreshed.kind === 'unavailable') {
        throw new Error(getVerbooModelsUnavailableMessage(refreshed.reason))
      }
    }
    throw new Error(
      'Sua assinatura está ativa, mas os modelos ainda não foram liberados. Tente novamente em instantes ou contate o suporte.',
    )
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
  process.stdout.write('\n  Para trocar de conta, execute: verboo logout\n\n')
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(1)
}

async function resolvePastDueBeforeModels(accessToken: string): Promise<void> {
  const resolved = await showPastDueNotice(accessToken)
  if (!resolved) {
    throw new Error(
      'Existe um pagamento pendente. Regularize a assinatura antes de escolher outro plano.',
    )
  }
}

async function ensureVerbooTermsAccepted(accessToken: string): Promise<void> {
  const result = await fetchVerbooTermsStatus(accessToken)
  if (result.kind === 'unauthorized') {
    throw new Error(
      'Sua sessão expirou durante a verificação dos Termos de Uso. Execute `verboo /login` e tente novamente.',
    )
  }
  if (result.kind === 'unavailable') {
    throw new Error(
      `Não foi possível verificar o aceite dos Termos de Uso: ${result.reason}. ` +
        'Por segurança, o acesso não será liberado sem essa verificação.',
    )
  }

  const { status } = result
  if (!status.configured) return
  if (!status.current) {
    throw new Error(
      'O servidor informou que existem Termos de Uso, mas não retornou a versão vigente.',
    )
  }

  if (status.mustAccept) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(getHeadlessTermsRequiredMessage(status))
    }
    const acceptance = await showVerbooTermsAcceptance(accessToken, status)
    if (acceptance.kind !== 'accepted') {
      throw new Error(
        'Os Termos de Uso não foram aceitos. O acesso ao produto permanece bloqueado.',
      )
    }
    process.stdout.write(
      `\n✓ Termos de Uso versão ${status.current.version} aceitos e registrados pelo servidor.\n\n`,
    )
    return
  }

  if (status.pendingReacceptance) {
    const deadline = formatTermsDeadline(status.current.enforcementAt)
    process.stderr.write(
      `\n⚠ Os Termos de Uso versão ${status.current.version} foram atualizados.` +
        `${deadline ? ` O aceite será obrigatório em ${deadline} (horário de Fortaleza).` : ''}` +
        `\nLeia em ${getPublicTermsURL(status)} e execute /terms para aceitar.\n\n`,
    )
  }
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

  const terms = await fetchVerbooTermsStatus(session.tokens.accessToken)
  if (terms.kind === 'unauthorized') {
    return { kind: 'needs-oauth', reason: 'unauthenticated' }
  }
  if (terms.kind === 'unavailable') {
    return {
      kind: 'degraded',
      reason: `verificação dos termos: ${terms.reason}`,
    }
  }
  if (terms.status.mustAccept) {
    return {
      kind: 'degraded',
      reason: `${getHeadlessTermsRequiredMessage(terms.status)} Execute /terms para aceitar diretamente no CLI.`,
    }
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
    await ensureVerbooTermsAccepted(session.tokens.accessToken)
    await resolvePastDueBeforeModels(session.tokens.accessToken)
    await loadAndCheckModels(session.tokens.accessToken)
    validated = true
    return
  }

  if (session.kind === 'degraded') {
    logForDebugging(
      `[VerbooStartup] Sessão degradada: ${session.reason}. Validando termos e roteador antes de liberar.`,
    )

    const stored = await getClaudeAIOAuthTokensAsync()
    if (!stored?.accessToken) {
      throw new Error('Não foi possível validar a sessão local do Verboo.')
    }
    await ensureVerbooTermsAccepted(stored.accessToken)
    await resolvePastDueBeforeModels(stored.accessToken)
    await loadAndCheckModels(stored.accessToken)
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

  saveGlobalConfig((current) =>
    current.hasCompletedOnboarding
      ? current
      : { ...current, hasCompletedOnboarding: true },
  )

  // In a transient `/api/me` outage, the freshly returned OAuth token can
  // still be valid, but terms and the router must both confirm access before
  // we mark the session as validated.
  const accessToken =
    confirmedSession.kind === 'ok'
      ? confirmedSession.tokens.accessToken
      : tokens.accessToken
  await ensureVerbooTermsAccepted(accessToken)
  await resolvePastDueBeforeModels(accessToken)
  await loadAndCheckModels(accessToken)
  validated = true
}
