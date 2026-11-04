import { describe, expect, test } from 'bun:test'

import {
  classifyProviderLimitError,
  formatProviderLimitMessage,
  limitSwitchReasonFromMessage,
  PROVIDER_LIMIT_MESSAGE_PREFIX,
} from './providerLimitErrors.js'

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0)

describe('classifyProviderLimitError', () => {
  test('ChatGPT plan usage limit (Codex) with renewal time', () => {
    const error = Object.assign(
      new Error('429 {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":3600}}'),
      { status: 429 },
    )
    const limit = classifyProviderLimitError(error, 'Codex', NOW)
    expect(limit?.providerLabel).toBe('ChatGPT')
    expect(limit?.resetsAt?.getTime()).toBe(NOW + 3_600_000)
  })

  test('OpenAI API key without quota', () => {
    const error = Object.assign(
      new Error('429 You exceeded your current quota, please check your plan and billing details.'),
      { status: 429, error: { code: 'insufficient_quota' } },
    )
    expect(classifyProviderLimitError(error, 'OpenAI', NOW)).toEqual({ providerLabel: 'OpenAI' })
  })

  test('Anthropic API key without credit', () => {
    const error = Object.assign(
      new Error('400 Your credit balance is too low to access the Anthropic API.'),
      { status: 400 },
    )
    expect(classifyProviderLimitError(error, 'Claude', NOW)).toEqual({ providerLabel: 'Anthropic' })
  })

  test('temporary rate limits and Verboo models are not account limits', () => {
    const rateLimited = Object.assign(new Error('429 Rate limit reached for requests'), { status: 429 })
    expect(classifyProviderLimitError(rateLimited, 'OpenAI', NOW)).toBeNull()
    expect(classifyProviderLimitError(rateLimited, 'Codex', NOW)).toBeNull()
    const quota = Object.assign(new Error('insufficient_quota'), { status: 429 })
    expect(classifyProviderLimitError(quota, 'Verboo', NOW)).toBeNull()
  })
})

test('the message carries the prefix the REPL uses to open the switch', () => {
  const text = formatProviderLimitMessage(
    { providerLabel: 'ChatGPT', resetsAt: new Date(NOW + 3_600_000) },
    NOW,
  )
  expect(text.startsWith(PROVIDER_LIMIT_MESSAGE_PREFIX)).toBe(true)
  expect(text).toContain('plano ChatGPT')
  expect(text).toContain('renova')
  expect(limitSwitchReasonFromMessage(text)).toContain('o limite do seu plano ChatGPT acabou')
  expect(limitSwitchReasonFromMessage('API Error: 500 Internal error')).toBeNull()
})

test('the API error path, retries and REPL are wired to the account limit flow', async () => {
  const { resolve } = await import('path')
  const read = (relative: string) => Bun.file(resolve(import.meta.dir, '../..', relative)).text()
  const errors = await read('services/api/errors.ts')
  expect(errors.indexOf('classifyProviderLimitError(')).toBeGreaterThan(-1)
  expect(errors.indexOf('classifyProviderLimitError(')).toBeLessThan(
    errors.indexOf('Your credit balance is too low'),
  )
  const retry = await read('services/api/withRetry.ts')
  expect(retry).toContain("msg.includes('usage_limit_reached')")
  expect(retry).toContain("msg.includes('insufficient_quota')")
  const repl = await read('screens/REPL.tsx')
  expect(repl).toContain('limitSwitchReasonFromMessage(')
  expect(repl).toContain('<LimitSwitchDialog')
  expect(repl).not.toContain('/limit-switch')
  expect(repl).toContain('useRef<string | undefined>(messages.at(-1)?.uuid)')
})
