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
  status: string
  wooviSubscriptionId?: string
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
