import { APIError } from '@anthropic-ai/sdk'
import { afterEach, expect, test } from 'bun:test'

import { PaymentPastDueError } from '../oauth/paymentPastDue.js'
import {
  classifyAPIError,
  CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE,
  getAssistantMessageFromError,
  PLAN_ACCESS_PENDING_ERROR_MESSAGE,
  PLAN_PROVISIONING_ERROR_MESSAGE,
} from './errors.js'

const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL

afterEach(() => {
  if (originalAnthropicBaseUrl === undefined) {
    delete process.env.ANTHROPIC_BASE_URL
  } else {
    process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseUrl
  }
})

function getFirstText(
  message: ReturnType<typeof getAssistantMessageFromError>,
): string {
  const first = message.message.content[0]
  if (!first || typeof first !== 'object' || !('text' in first)) {
    return ''
  }
  return typeof first.text === 'string' ? first.text : ''
}

test('typed Verboo provisioning code reports plan activation', () => {
  const error = APIError.generate(
    401,
    {
      error: {
        code: 'plan_provisioning',
        message: 'Plan entitlement is still provisioning',
      },
    },
    undefined,
    new Headers(),
  )

  const message = getAssistantMessageFromError(error, 'deepseek-v4-pro')
  const text = getFirstText(message)

  expect(message.isApiErrorMessage).toBe(true)
  expect(message.error).toBe('billing_error')
  expect(text).toBe(PLAN_PROVISIONING_ERROR_MESSAGE)
  expect(text).not.toContain('/login')
})

test('legacy exact Verboo credit message uses neutral pending copy', () => {
  const error = APIError.generate(
    401,
    { error: 'Not Enough Credits' },
    undefined,
    new Headers(),
  )

  const message = getAssistantMessageFromError(error, 'deepseek-v4-pro')

  expect(message.error).toBe('billing_error')
  expect(getFirstText(message)).toBe(PLAN_ACCESS_PENDING_ERROR_MESSAGE)
})

test('external provider 401 is never described as Verboo provisioning', () => {
  process.env.ANTHROPIC_BASE_URL = 'https://provider.example/v1'
  const error = APIError.generate(
    401,
    { error: 'Not Enough Credits' },
    undefined,
    new Headers(),
  )

  const message = getAssistantMessageFromError(error, 'external-model')
  const text = getFirstText(message)

  expect(text).not.toContain(PLAN_PROVISIONING_ERROR_MESSAGE)
  expect(text).not.toContain(PLAN_ACCESS_PENDING_ERROR_MESSAGE)
  expect(message.error).toBe('authentication_failed')
})

test('typed exhausted credits stay a billing error without activation copy', () => {
  const error = APIError.generate(
    401,
    {
      error: {
        code: 'insufficient_credits',
        message: 'No credits remain',
      },
    },
    undefined,
    new Headers(),
  )

  const message = getAssistantMessageFromError(error, 'deepseek-v4-pro')

  expect(message.error).toBe('billing_error')
  expect(getFirstText(message)).toBe(CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE)
})

test('real authentication 401 still directs the user to login', () => {
  const error = APIError.generate(
    401,
    undefined,
    'Invalid bearer token',
    new Headers(),
  )

  const message = getAssistantMessageFromError(error, 'deepseek-v4-pro')
  const text = getFirstText(message)

  expect(message.isApiErrorMessage).toBe(true)
  expect(message.error).toBe('authentication_failed')
  expect(text).toContain('/login')
})

const PAST_DUE_SERVER_MESSAGE =
  'Payment past due: the renewal of your Verboo Code subscription failed, so access is paused. Pay the open invoice at https://code.verboo.ai/en/settings/billing to restore access.'
const PAST_DUE_BODY = {
  error: {
    message: PAST_DUE_SERVER_MESSAGE,
    type: 'billing_error',
    code: 'payment_past_due',
  },
}

test('router past-due error explains the failed renewal with the server billing link', () => {
  const message = getAssistantMessageFromError(
    new PaymentPastDueError(PAST_DUE_SERVER_MESSAGE),
    'deepseek-v4-pro',
  )
  const text = getFirstText(message)

  expect(message.isApiErrorMessage).toBe(true)
  expect(message.error).toBe('billing_error')
  expect(text).toBe(
    'Pagamento pendente: a renovação da sua assinatura Verboo Code falhou e o acesso está pausado. Pague a fatura em aberto em https://code.verboo.ai/pt/settings/billing para liberar o acesso.',
  )
  expect(text).not.toContain('/login')
  expect(classifyAPIError(new PaymentPastDueError())).toBe('payment_past_due')
})

test('past-due copy falls back to the fixed billing link and ignores foreign links', () => {
  expect(new PaymentPastDueError().message).toContain(
    'https://code.verboo.ai/pt/settings/billing',
  )
  const foreign = new PaymentPastDueError(
    'Payment past due. Pay at https://evil.example/settings/billing now.',
  )
  expect(foreign.message).toContain('https://code.verboo.ai/pt/settings/billing')
  expect(foreign.message).not.toContain('evil.example')
})

test('a 402 past-due JSON body is mapped even though the SDK drops the category marker', () => {
  // The SDK replaces the message with the stringified JSON body.
  const error = APIError.generate(
    402,
    PAST_DUE_BODY,
    'OpenAI API error 402: ... [openai_category=payment_past_due,host=code.verboo.ai]',
    new Headers(),
  )
  expect(error.message).not.toContain('openai_category')

  const message = getAssistantMessageFromError(error, 'deepseek-v4-pro')
  const text = getFirstText(message)

  expect(message.error).toBe('billing_error')
  expect(text).toContain('Pagamento pendente')
  expect(text).toContain('https://code.verboo.ai/pt/settings/billing')
  expect(text).not.toContain('{"error"')
  expect(text).not.toContain('/login')
})

test('a past-due category marker maps to the same billing message', () => {
  const error = APIError.generate(
    402,
    undefined,
    `OpenAI API error 402: ${JSON.stringify(PAST_DUE_BODY)} [openai_category=payment_past_due,host=code.verboo.ai]`,
    new Headers(),
  )

  const message = getAssistantMessageFromError(error, 'deepseek-v4-pro')

  expect(message.error).toBe('billing_error')
  expect(getFirstText(message)).toContain(
    'Pague a fatura em aberto em https://code.verboo.ai/pt/settings/billing',
  )
})

test('external provider 402 is never described as a Verboo past-due subscription', () => {
  process.env.ANTHROPIC_BASE_URL = 'https://provider.example/v1'
  const error = APIError.generate(402, PAST_DUE_BODY, undefined, new Headers())

  const message = getAssistantMessageFromError(error, 'external-model')

  expect(getFirstText(message)).not.toContain('Pagamento pendente')
  expect(message.error).toBe('unknown')
})
