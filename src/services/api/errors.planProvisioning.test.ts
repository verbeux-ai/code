import { APIError } from '@anthropic-ai/sdk'
import { expect, test } from 'bun:test'

import { getAssistantMessageFromError } from './errors.js'

function getFirstText(
  message: ReturnType<typeof getAssistantMessageFromError>,
): string {
  const first = message.message.content[0]
  if (!first || typeof first !== 'object' || !('text' in first)) {
    return ''
  }
  return typeof first.text === 'string' ? first.text : ''
}

test('401 "Not Enough Credits" (provisionamento pós-upgrade) NÃO manda pro login', () => {
  const error = APIError.generate(
    401,
    undefined,
    'Not Enough Credits',
    new Headers(),
  )

  const message = getAssistantMessageFromError(error, 'deepseek-v4-pro')
  const text = getFirstText(message)

  expect(message.isApiErrorMessage).toBe(true)
  // mostra que o plano está sendo ativado...
  expect(text.toLowerCase()).toContain('plan is being activated')
  // ...e NÃO pede login (que não resolveria)
  expect(text).not.toContain('/login')
})

test('401 de autenticação real CONTINUA orientando /login (sem regressão)', () => {
  const error = APIError.generate(
    401,
    undefined,
    'Invalid bearer token',
    new Headers(),
  )

  const message = getAssistantMessageFromError(error, 'deepseek-v4-pro')
  const text = getFirstText(message)

  expect(message.isApiErrorMessage).toBe(true)
  expect(text).toContain('/login')
})
