import { AuthCodeListener } from '../oauth/auth-code-listener.js'
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
} from '../oauth/crypto.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import {
  CLAUDE_NATIVE_API_BASE_URL,
  CLAUDE_NATIVE_AUTHORIZE_URL,
  CLAUDE_NATIVE_CLIENT_ID,
  CLAUDE_NATIVE_SCOPES,
  CLAUDE_NATIVE_TOKEN_URL,
} from './claudeNativeConfig.js'

type NativeTokenResponse = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  account?: { uuid?: string; email_address?: string }
  organization?: { uuid?: string }
  plan?: unknown
  subscription?: unknown
}

type NativeProfileResponse = {
  account?: { uuid?: string; email?: string; email_address?: string }
  organization?: { uuid?: string; plan?: unknown; subscription?: unknown }
  plan?: unknown
  subscription?: unknown
}

export type ClaudePlanHint = {
  id: 'pro' | 'max'
  displayName: 'Pro' | 'Max'
}

export type ClaudeNativeOAuthTokens = {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  scopes: string[]
  accountId: string
  email?: string
  organizationId?: string
  planId?: ClaudePlanHint['id']
  planDisplayName?: ClaudePlanHint['displayName']
}

type Listener = Pick<
  AuthCodeListener,
  | 'start'
  | 'hasPendingResponse'
  | 'waitForAuthorization'
  | 'handleSuccessRedirect'
  | 'handleErrorRedirect'
  | 'cancelPendingAuthorization'
>

type Options = {
  callbackHost?: string
  callbackPort?: number
  createAuthCodeListener?: (callbackPath: string) => Listener
}

function trimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function normalizeClaudePlanHint(value: unknown): ClaudePlanHint | undefined {
  const candidates = typeof value === 'string'
    ? [value]
    : value && typeof value === 'object'
      ? [
          (value as Record<string, unknown>).id,
          (value as Record<string, unknown>).plan_id,
          (value as Record<string, unknown>).planId,
          (value as Record<string, unknown>).tier,
          (value as Record<string, unknown>).type,
          (value as Record<string, unknown>).plan_type,
          (value as Record<string, unknown>).planType,
          (value as Record<string, unknown>).subscription_type,
          (value as Record<string, unknown>).subscriptionType,
          (value as Record<string, unknown>).name,
          (value as Record<string, unknown>).display_name,
          (value as Record<string, unknown>).displayName,
        ]
      : []
  for (const candidate of candidates) {
    const normalized = trimmed(candidate)?.toLowerCase().replaceAll('_', '-').replaceAll(' ', '-')
    if (normalized === 'pro' || normalized === 'claude-pro') {
      return { id: 'pro', displayName: 'Pro' }
    }
    if (normalized === 'max' || normalized === 'claude-max') {
      return { id: 'max', displayName: 'Max' }
    }
  }
  return undefined
}

function profilePlanHint(profile: NativeProfileResponse | undefined): ClaudePlanHint | undefined {
  if (!profile) return undefined
  return normalizeClaudePlanHint(profile.plan) ??
    normalizeClaudePlanHint(profile.subscription) ??
    normalizeClaudePlanHint(profile.organization?.plan) ??
    normalizeClaudePlanHint(profile.organization?.subscription)
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function callbackUri(host: string, port: number): string {
  return `http://${host}:${port}/callback`
}

export function buildClaudeNativeAuthorizeUrl(options: {
  host: string
  port: number
  codeChallenge: string
  state: string
}): string {
  const url = new URL(CLAUDE_NATIVE_AUTHORIZE_URL)
  url.searchParams.set('code', 'true')
  url.searchParams.set('client_id', CLAUDE_NATIVE_CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', callbackUri(options.host, options.port))
  url.searchParams.set('scope', CLAUDE_NATIVE_SCOPES.join(' '))
  url.searchParams.set('code_challenge', options.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', options.state)
  return url.toString()
}

async function fetchProfile(
  accessToken: string,
  signal?: AbortSignal,
): Promise<NativeProfileResponse | undefined> {
  const { signal: combinedSignal, cleanup } = createCombinedAbortSignal(signal, {
    timeoutMs: 10_000,
  })
  try {
    const response = await fetch(`${CLAUDE_NATIVE_API_BASE_URL}/api/oauth/profile`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      signal: combinedSignal,
    })
    if (!response.ok) return undefined
    return (await response.json()) as NativeProfileResponse
  } finally {
    cleanup()
  }
}

async function exchangeCode(options: {
  authorizationCode: string
  codeVerifier: string
  state: string
  host: string
  port: number
  signal?: AbortSignal
}): Promise<ClaudeNativeOAuthTokens> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: options.authorizationCode,
    redirect_uri: callbackUri(options.host, options.port),
    client_id: CLAUDE_NATIVE_CLIENT_ID,
    code_verifier: options.codeVerifier,
    state: options.state,
  })
  const { signal, cleanup } = createCombinedAbortSignal(options.signal, {
    timeoutMs: 15_000,
  })
  let payload: NativeTokenResponse
  try {
    const response = await fetch(CLAUDE_NATIVE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal,
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).trim().slice(0, 500)
      throw new Error(
        detail
          ? `Falha no OAuth Claude (${response.status}): ${detail}`
          : `Falha no OAuth Claude (${response.status}).`,
      )
    }
    payload = (await response.json()) as NativeTokenResponse
  } finally {
    cleanup()
  }

  const accessToken = trimmed(payload.access_token)
  if (!accessToken) throw new Error('O OAuth Claude não retornou um access token.')

  const profile = await fetchProfile(accessToken, options.signal).catch(
    () => undefined,
  )
  const accountId =
    trimmed(payload.account?.uuid) ?? trimmed(profile?.account?.uuid)
  if (!accountId) {
    throw new Error('O OAuth Claude não identificou a conta autenticada.')
  }
  const expiresIn =
    typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : undefined

  return {
    accessToken,
    refreshToken: trimmed(payload.refresh_token),
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
    scopes:
      trimmed(payload.scope)?.split(/\s+/).filter(Boolean) ??
      [...CLAUDE_NATIVE_SCOPES],
    accountId,
    email:
      trimmed(payload.account?.email_address) ??
      trimmed(profile?.account?.email_address) ??
      trimmed(profile?.account?.email),
    organizationId:
      trimmed(payload.organization?.uuid) ??
      trimmed(profile?.organization?.uuid),
    planId:
      profilePlanHint(profile)?.id ??
      normalizeClaudePlanHint(payload.plan)?.id ??
      normalizeClaudePlanHint(payload.subscription)?.id,
    planDisplayName:
      profilePlanHint(profile)?.displayName ??
      normalizeClaudePlanHint(payload.plan)?.displayName ??
      normalizeClaudePlanHint(payload.subscription)?.displayName,
  }
}

function page(title: string, message: string, error = false): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:sans-serif;padding:32px;line-height:1.5;color:#111827}h1{font-size:22px;color:${error ? '#991b1b' : '#111827'}}</style></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p>Você pode voltar ao Verboo Code.</p></body></html>`
}

export class ClaudeNativeOAuthService {
  private listener: Listener | null = null
  private exchangeAbortController: AbortController | null = null

  constructor(private readonly options: Options = {}) {}

  private cancellationError(): Error {
    return new Error('Login Claude cancelado.')
  }

  async startOAuthFlow(
    onAuthorizationUrl: (url: string) => void | Promise<void>,
  ): Promise<ClaudeNativeOAuthTokens> {
    const host = this.options.callbackHost ?? 'localhost'
    const codeVerifier = generateCodeVerifier()
    const listener =
      this.options.createAuthCodeListener?.('/callback') ??
      new AuthCodeListener('/callback')
    this.listener = listener

    try {
      const port = await listener.start(this.options.callbackPort, host)
      const state = generateState()
      const codeChallenge = await generateCodeChallenge(codeVerifier)
      const authUrl = buildClaudeNativeAuthorizeUrl({
        host,
        port,
        codeChallenge,
        state,
      })
      try {
        const authorizationCode = await listener.waitForAuthorization(
          state,
          async () => onAuthorizationUrl(authUrl),
        )
        const controller = new AbortController()
        this.exchangeAbortController = controller
        let tokens: ClaudeNativeOAuthTokens
        try {
          tokens = await exchangeCode({
            authorizationCode,
            codeVerifier,
            state,
            host,
            port,
            signal: controller.signal,
          })
        } finally {
          if (this.exchangeAbortController === controller) {
            this.exchangeAbortController = null
          }
        }
        if (this.listener !== listener) throw this.cancellationError()
        listener.handleSuccessRedirect([], response => {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          response.end(page('Login Claude concluído', 'O Verboo está liberando os modelos da sua conta.'))
        })
        return tokens
      } catch (error) {
        const resolved = this.listener === listener ? error : this.cancellationError()
        if (listener.hasPendingResponse()) {
          const cancelled =
            resolved instanceof Error && resolved.message === 'Login Claude cancelado.'
          listener.handleErrorRedirect(response => {
            response.writeHead(cancelled ? 200 : 400, {
              'Content-Type': 'text/html; charset=utf-8',
            })
            response.end(
              page(
                cancelled ? 'Login Claude cancelado' : 'Falha no login Claude',
                cancelled
                  ? 'Nenhuma credencial Claude foi salva.'
                  : resolved instanceof Error
                    ? resolved.message
                    : String(resolved),
                !cancelled,
              ),
            )
          })
        }
        throw resolved
      } finally {
        this.cleanup()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('EADDRINUSE')) {
        throw new Error('Não foi possível abrir o callback local do OAuth Claude.')
      }
      throw error
    }
  }

  cleanup(): void {
    const error = this.cancellationError()
    this.exchangeAbortController?.abort(error)
    this.exchangeAbortController = null
    if (this.listener?.hasPendingResponse()) {
      this.listener.handleErrorRedirect(response => {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(page('Login Claude cancelado', 'Nenhuma credencial Claude foi salva.'))
      })
    }
    this.listener?.cancelPendingAuthorization(error)
    this.listener = null
  }
}
