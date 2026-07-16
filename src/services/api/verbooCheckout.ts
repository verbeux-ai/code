import axios from 'axios'

import { VERBOO_API_BASE_URL } from '../../constants/oauth.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'

export type CheckoutResult =
  | { mode: 'stripe'; url: string }
  | { mode: 'woovi'; wooviQrCode: string; wooviSubscriptionId: string }
  | { mode: 'reactivated' }

export type PaymentMethod = 'stripe' | 'woovi'

export type WooviCheckoutData = {
  taxId: string
  phone: string
}

export type CheckoutInput = {
  paymentMethod: PaymentMethod
  woovi?: WooviCheckoutData
}

type SubscriptionSummary = {
  groupId?: string
  status: string
  wooviSubscriptionId?: string
}

export type WhatsAppProfile = {
  verified: boolean
  maskedPhone?: string
  countryCode?: string
}

export type CardlessTrialInput = {
  useVerifiedPhone: boolean
	phone?: string
	countryCode?: string
}

export type CardlessTrialResult = {
  mode: 'verification_required' | 'trial_activated'
  verificationId?: string
  maskedPhone?: string
  expiresAt?: string
  resendAt?: string
  attemptsRemaining?: number
  groupId?: string
  status?: string
}

export async function createCheckoutSession(
  accessToken: string,
  groupId: string,
  input: CheckoutInput,
): Promise<CheckoutResult> {
  const endpoint = `${VERBOO_API_BASE_URL}/api/me/groups/${groupId}/checkout`
  try {
    const response = await axios.post<{ data: CheckoutResult }>(
      endpoint,
      input,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 15_000,
      },
    )
    const result = response.data?.data
    if (!result || !result.mode) {
      throw new Error('Resposta invalida do checkout')
    }
    return result
  } catch (error) {
    logError(error as Error)
    const msg = `[Checkout] Erro ao criar sessao: ${(error as Error).message ?? String(error)}`
    logForDebugging(msg)
    throw new Error(msg)
  }
}

export async function isWooviSubscriptionActive(
  accessToken: string,
  wooviSubscriptionId: string,
): Promise<boolean> {
  const endpoint = `${VERBOO_API_BASE_URL}/api/me/subscriptions`
  const response = await axios.get<{ data: SubscriptionSummary[] }>(endpoint, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    timeout: 10_000,
  })
  return (response.data?.data ?? []).some(
    sub =>
      sub.wooviSubscriptionId === wooviSubscriptionId && sub.status === 'active',
  )
}

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
}

export async function getWhatsAppProfile(accessToken: string): Promise<WhatsAppProfile> {
  const endpoint = `${VERBOO_API_BASE_URL}/api/me/whatsapp`
  const response = await axios.get<{ data: WhatsAppProfile }>(endpoint, {
    headers: authHeaders(accessToken),
    timeout: 10_000,
  })
  return response.data.data
}

export async function startCardlessTrial(
  accessToken: string,
  groupId: string,
  input: CardlessTrialInput,
): Promise<CardlessTrialResult> {
  const endpoint = `${VERBOO_API_BASE_URL}/api/me/groups/${groupId}/cardless-trial`
  const response = await axios.post<{ data: CardlessTrialResult }>(endpoint, input, {
    headers: authHeaders(accessToken),
    timeout: 15_000,
  })
  return response.data.data
}

export async function confirmCardlessTrial(
  accessToken: string,
  verificationId: string,
  code: string,
): Promise<CardlessTrialResult> {
  const endpoint = `${VERBOO_API_BASE_URL}/api/me/cardless-trial-verifications/${verificationId}/confirm`
  const response = await axios.post<{ data: CardlessTrialResult }>(endpoint, { code }, {
    headers: authHeaders(accessToken),
    timeout: 15_000,
  })
  return response.data.data
}

export async function resendCardlessTrialCode(
  accessToken: string,
  verificationId: string,
): Promise<CardlessTrialResult> {
  const endpoint = `${VERBOO_API_BASE_URL}/api/me/cardless-trial-verifications/${verificationId}/resend`
  const response = await axios.post<{ data: CardlessTrialResult }>(endpoint, undefined, {
    headers: authHeaders(accessToken),
    timeout: 15_000,
  })
  return response.data.data
}

export async function isGroupSubscriptionActive(accessToken: string, groupId: string): Promise<boolean> {
  const endpoint = `${VERBOO_API_BASE_URL}/api/me/subscriptions`
  const response = await axios.get<{ data: SubscriptionSummary[] }>(endpoint, {
    headers: authHeaders(accessToken),
    timeout: 10_000,
  })
  return (response.data?.data ?? []).some(
    sub => sub.groupId === groupId && (sub.status === 'active' || sub.status === 'trialing'),
  )
}
