import axios from 'axios'

import { VERBOO_API_BASE_URL } from '../../constants/oauth.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'

export type CheckoutResult =
  | { mode: 'stripe'; url: string }
  | { mode: 'trial'; subscriptionId: string; trialEndAt: string }
  | { mode: 'woovi'; wooviQrCode: string; wooviSubscriptionId: string }

export async function createCheckoutSession(
  accessToken: string,
  groupId: string,
): Promise<CheckoutResult> {
  const endpoint = `${VERBOO_API_BASE_URL}/api/me/groups/${groupId}/checkout`
  try {
    const response = await axios.post<{ data: CheckoutResult }>(
      endpoint,
      {},
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
