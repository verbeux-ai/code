import { APIError } from '@anthropic-ai/sdk'
import { afterEach, expect, test } from 'bun:test'

import {
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
