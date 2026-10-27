import { VERBOO_FRONT_BASE_URL } from '../../constants/oauth.js'

export const PAYMENT_PAST_DUE_CODE = 'payment_past_due'
export const PAYMENT_PAST_DUE_BILLING_URL = `${VERBOO_FRONT_BASE_URL}/pt/settings/billing`

/**
 * The router message carries the billing link. Only a link on the Verboo site
 * is reused, so the CLI never repeats an arbitrary URL from a response body.
 */
export function getPaymentPastDueBillingUrl(serverMessage?: string): string {
  const allowedOrigin = new URL(VERBOO_FRONT_BASE_URL).origin
  for (const match of serverMessage?.matchAll(/https:\/\/[^\s"'<>]+/g) ?? []) {
    try {
      const url = new URL(match[0].replace(/[.,;:!?)\]]+$/, ''))
      if (url.origin === allowedOrigin) return url.href
    } catch {
      // Not a URL; keep looking.
    }
  }
  return PAYMENT_PAST_DUE_BILLING_URL
}

export function getPaymentPastDueMessage(serverMessage?: string): string {
  return `Pagamento pendente: a renovação da sua assinatura Verboo Code falhou e o acesso está pausado. Pague a fatura em aberto em ${getPaymentPastDueBillingUrl(serverMessage)} para liberar o acesso.`
}

/**
 * Recognizes the router's `402 {"error":{"code":"payment_past_due"}}`
 * envelope. `body` may be the raw response text or the parsed JSON.
 */
export function parsePaymentPastDue(
  status: number | undefined,
  body: unknown,
): { serverMessage?: string } | undefined {
  if (status !== 402) return undefined
  let parsed = body
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body)
    } catch {
      return undefined
    }
  }
  const error =
    parsed && typeof parsed === 'object'
      ? (parsed as { error?: unknown }).error
      : undefined
  if (!error || typeof error !== 'object') return undefined
  const { code, message } = error as { code?: unknown; message?: unknown }
  if (code !== PAYMENT_PAST_DUE_CODE) return undefined
  return typeof message === 'string' ? { serverMessage: message } : {}
}

export class PaymentPastDueError extends Error {
  readonly status = 402
  readonly code = PAYMENT_PAST_DUE_CODE
  readonly billingUrl: string
  constructor(serverMessage?: string) {
    super(getPaymentPastDueMessage(serverMessage))
    this.name = 'PaymentPastDueError'
    this.billingUrl = getPaymentPastDueBillingUrl(serverMessage)
  }
}

/**
 * The router just denied access, so a grant cached before the renewal failed
 * is stale. Dropping it makes the next request re-check the subscription.
 * Never retried: access only returns after the invoice is paid.
 */
export async function paymentPastDueError(
  serverMessage?: string,
): Promise<PaymentPastDueError> {
  const { clearCLIEntitlementCache } = await import('./cliEntitlement.js')
  clearCLIEntitlementCache()
  return new PaymentPastDueError(serverMessage)
}
