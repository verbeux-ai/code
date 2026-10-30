import { expect, test } from 'bun:test'

import { PaymentPastDueError } from '../../../services/oauth/paymentPastDue.js'
import { verbooRouterSearchError } from './verbooRouter.ts'

test('a past-due 402 from router search shows the billing link instead of the raw body', async () => {
  const error = await verbooRouterSearchError(
    new Response(
      JSON.stringify({
        error: {
          message:
            'Payment past due: the renewal of your Verboo Code subscription failed, so access is paused. Pay the open invoice at https://code.verboo.ai/en/settings/billing to restore access.',
          type: 'billing_error',
          code: 'payment_past_due',
        },
      }),
      { status: 402, headers: { 'Content-Type': 'application/json' } },
    ),
  )

  expect(error).toBeInstanceOf(PaymentPastDueError)
  expect(error.message).toBe(
    'Pagamento pendente: a renovação da sua assinatura Verboo Code falhou e o acesso está pausado. Pague a fatura em aberto em https://code.verboo.ai/pt/settings/billing para liberar o acesso.',
  )
})

test('other router search failures keep the raw status and body', async () => {
  const error = await verbooRouterSearchError(
    new Response('{"error":{"code":"upstream_unavailable"}}', { status: 502 }),
  )

  expect(error).not.toBeInstanceOf(PaymentPastDueError)
  expect(error.message).toBe(
    'verboo-router search error 502: {"error":{"code":"upstream_unavailable"}}',
  )
})
