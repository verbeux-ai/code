import axios from 'axios'

import { getOauthConfig } from '../../constants/oauth.js'
import { errorMessage } from '../../utils/errors.js'

export type VerbooTermsLocale = 'pt' | 'en'

export type VerbooTermsVersion = {
  id: string
  version: number
  isCurrent: boolean
  title: string
  locale: VerbooTermsLocale
  availableLocales: VerbooTermsLocale[]
  changeSummary: string
  requiresReacceptance: boolean
  enforcementAt?: string
  publishedAt?: string
}

export type VerbooTermsStatus = {
  configured: boolean
  current?: VerbooTermsVersion
  acceptedAt?: string
  mustAccept: boolean
  pendingReacceptance: boolean
  acceptUrl?: string
}

export type VerbooTermsAcceptance = {
  id: string
  termsVersionId: string
  acceptedAt: string
  contentLocale: VerbooTermsLocale
  contentSha256: string
  channel: string
  requestId: string
}

export type VerbooTermsStatusResult =
  | { kind: 'ok'; status: VerbooTermsStatus }
  | { kind: 'unauthorized' }
  | { kind: 'unavailable'; reason: string }

type ApiEnvelope<T> = { data?: T }

function requestHeaders(accessToken: string, locale: VerbooTermsLocale) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'Accept-Language': locale === 'en' ? 'en' : 'pt-BR',
  }
}

export function getPreferredTermsLocale(): VerbooTermsLocale {
  const language = process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG
  return language?.toLowerCase().startsWith('en') ? 'en' : 'pt'
}

export async function fetchVerbooTermsStatus(
  accessToken: string,
  locale: VerbooTermsLocale = getPreferredTermsLocale(),
): Promise<VerbooTermsStatusResult> {
  const endpoint = `${getOauthConfig().BASE_API_URL}/api/me/terms/status?locale=${locale}`
  try {
    const response = await axios.get<ApiEnvelope<VerbooTermsStatus>>(endpoint, {
      headers: requestHeaders(accessToken, locale),
      timeout: 5_000,
      validateStatus: () => true,
    })
    if (response.status === 200 && response.data?.data) {
      return { kind: 'ok', status: response.data.data }
    }
    if (response.status === 401 || response.status === 403) {
      return { kind: 'unauthorized' }
    }
    return { kind: 'unavailable', reason: `HTTP ${response.status}` }
  } catch (error) {
    return { kind: 'unavailable', reason: errorMessage(error) }
  }
}

export async function acceptVerbooTerms(
  accessToken: string,
  versionId: string,
  locale: VerbooTermsLocale,
): Promise<VerbooTermsAcceptance> {
  const endpoint = `${getOauthConfig().BASE_API_URL}/api/me/terms/accept`
  const response = await axios.post<ApiEnvelope<VerbooTermsAcceptance>>(
    endpoint,
    { versionId, locale, accepted: true },
    {
      headers: requestHeaders(accessToken, locale),
      timeout: 10_000,
      validateStatus: () => true,
    },
  )
  if (response.status === 200 && response.data?.data) {
    return response.data.data
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('Sua sessão expirou. Execute /login e tente novamente.')
  }
  if (response.status === 409) {
    throw new Error('A versão vigente mudou enquanto você lia os termos.')
  }
  const body = response.data as { error?: unknown }
  const detail = typeof body?.error === 'string' ? `: ${body.error}` : ''
  throw new Error(`Não foi possível registrar o aceite (HTTP ${response.status})${detail}`)
}

export function getPublicTermsURL(status: VerbooTermsStatus): string {
  if (status.acceptUrl) {
    try {
      const url = new URL(status.acceptUrl)
      url.pathname = url.pathname.replace(/\/terms\/accept\/?$/, '/terms')
      if (status.current?.version) {
        url.searchParams.set('version', String(status.current.version))
      }
      url.searchParams.delete('return_to')
      return url.toString()
    } catch {
      // The server normally returns an absolute URL. Keep a useful fallback
      // below if an older deployment returns a malformed value.
    }
  }

  const base = getOauthConfig().BASE_API_URL.replace(/\/+$/, '')
  const version = status.current?.version
  return version
    ? `${base}/api/terms/versions/${version}?locale=${status.current?.locale ?? 'pt'}`
    : `${base}/api/terms/current?locale=pt`
}

export function formatTermsDeadline(value?: string): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'medium',
    timeZone: 'America/Fortaleza',
  }).format(date)
}

export function getHeadlessTermsRequiredMessage(status: VerbooTermsStatus): string {
  const version = status.current?.version
    ? ` (versão ${status.current.version})`
    : ''
  return (
    `É necessário aceitar os Termos de Uso${version} antes de usar o Verboo Code.\n` +
    `Leia e aceite em ${getPublicTermsURL(status)} ou execute \`verboo\` em um terminal interativo.\n` +
    'O modo headless nunca aceita termos automaticamente.'
  )
}
