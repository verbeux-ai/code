/**
 * Requests on the user's own accounts must not present themselves as another
 * product nor carry the ids that belong to the Verboo router, and a model the
 * transport cannot use must not reach /model.
 */
import { expect, test } from 'bun:test'

import { getAttributionHeader } from '../../constants/system.js'
import { getAllModelBetas } from '../../utils/betas.js'
import { getContextWindowForModel, getModelMaxOutputTokens } from '../../utils/context.js'
import { getAPIMetadata } from './claude.js'
import { isOpenAIChatModelId, OPENAI_API_MODEL_PREFIX } from './openaiApiModels.js'

test('no request carries the Claude Code beta or the attribution block', () => {
  expect(getAllModelBetas('claude-sonnet-4-5-20250929')).not.toContain('claude-code-20250219')
  expect(getAttributionHeader('abc')).toBe('')
})

test('requests on the OpenAI key carry no device, account or session ids', () => {
  expect(getAPIMetadata(`${OPENAI_API_MODEL_PREFIX}gpt-5.5`)).toBeUndefined()
})

test('OpenAI key models use their real limits, and unknown ones a safe output cap', () => {
  const gpt4o = `${OPENAI_API_MODEL_PREFIX}gpt-4o`
  expect(getModelMaxOutputTokens(gpt4o)).toEqual({ default: 16_384, upperLimit: 16_384 })
  expect(getContextWindowForModel(gpt4o)).toBe(128_000)
  expect(getModelMaxOutputTokens(`${OPENAI_API_MODEL_PREFIX}gpt-unknown-9`).upperLimit).toBe(16_384)
})

test('/model hides what Chat Completions rejects or cannot drive the agent', () => {
  for (const id of ['gpt-5-pro', 'o1-pro', 'gpt-5-codex', 'gpt-3.5-turbo', 'gpt-4', 'gpt-4-turbo', 'o1-mini']) {
    expect(isOpenAIChatModelId(id)).toBe(false)
  }
  for (const id of ['gpt-5.5', 'gpt-5.5-mini', 'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3']) {
    expect(isOpenAIChatModelId(id)).toBe(true)
  }
})
