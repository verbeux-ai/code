import { afterEach, expect, mock, test } from 'bun:test'

import {
  getPaymentPastDueBillingUrl,
  parsePaymentPastDue,
  paymentPastDueError,
  PaymentPastDueError,
} from './paymentPastDue.js'

const SERVER_MESSAGE =
  'Payment past due: the renewal of your Verboo Code subscription failed, so access is paused. Pay the open invoice at https://code.verboo.ai/en/settings/billing to restore access.'
const BODY = {
  error: {
    message: SERVER_MESSAGE,
    type: 'billing_error',
    code: 'payment_past_due',
  },
}

const actualEntitlement = { ...(await import('./cliEntitlement.js')) }

afterEach(() => {
  mock.module('./cliEntitlement.js', () => actualEntitlement)
})

test('recognizes only the router 402 payment_past_due envelope', () => {
  expect(parsePaymentPastDue(402, BODY)).toEqual({ serverMessage: SERVER_MESSAGE })
  expect(parsePaymentPastDue(402, JSON.stringify(BODY))).toEqual({
    serverMessage: SERVER_MESSAGE,
  })
  expect(
    parsePaymentPastDue(402, { error: { code: 'payment_past_due' } }),
  ).toEqual({})
  expect(parsePaymentPastDue(401, BODY)).toBeUndefined()
  expect(parsePaymentPastDue(undefined, BODY)).toBeUndefined()
  expect(
    parsePaymentPastDue(402, { error: { code: 'free_tokens_exhausted' } }),
  ).toBeUndefined()
  expect(parsePaymentPastDue(402, 'Payment Required')).toBeUndefined()
  expect(parsePaymentPastDue(402, 'null')).toBeUndefined()
  expect(parsePaymentPastDue(402, { error: 'payment_past_due' })).toBeUndefined()
})

test('reuses a Verboo billing link from the server and falls back to the fixed one', () => {
  expect(getPaymentPastDueBillingUrl(SERVER_MESSAGE)).toBe(
    'https://code.verboo.ai/en/settings/billing',
  )
  expect(
    getPaymentPastDueBillingUrl('Pay at https://code.verboo.ai/en/settings/billing.'),
  ).toBe('https://code.verboo.ai/en/settings/billing')
  expect(getPaymentPastDueBillingUrl(undefined)).toBe(
    'https://code.verboo.ai/pt/settings/billing',
  )
  expect(getPaymentPastDueBillingUrl('Pay the open invoice.')).toBe(
    'https://code.verboo.ai/pt/settings/billing',
  )
  expect(
    getPaymentPastDueBillingUrl('Pay at https://code.verboo.ai.evil.example/billing'),
  ).toBe('https://code.verboo.ai/pt/settings/billing')
  expect(
    getPaymentPastDueBillingUrl('Pay at http://code.verboo.ai/en/settings/billing'),
  ).toBe('https://code.verboo.ai/pt/settings/billing')
})

test('the error is a terminal 402 billing error with the billing link', () => {
  const error = new PaymentPastDueError(SERVER_MESSAGE)
  expect(error).toMatchObject({
    name: 'PaymentPastDueError',
    status: 402,
    code: 'payment_past_due',
    billingUrl: 'https://code.verboo.ai/en/settings/billing',
  })
  expect(error.message).toBe(
    'Pagamento pendente: a renovação da sua assinatura Verboo Code falhou e o acesso está pausado. Pague a fatura em aberto em https://code.verboo.ai/en/settings/billing para liberar o acesso.',
  )
})

test('a router past-due rejection drops the cached CLI entitlement', async () => {
  let clears = 0
  mock.module('./cliEntitlement.js', () => ({
    ...actualEntitlement,
    clearCLIEntitlementCache: () => {
      clears++
      actualEntitlement.clearCLIEntitlementCache()
    },
  }))

  const error = await paymentPastDueError(SERVER_MESSAGE)

  expect(clears).toBe(1)
  expect(error).toBeInstanceOf(PaymentPastDueError)
  expect(error.billingUrl).toBe('https://code.verboo.ai/en/settings/billing')
})
