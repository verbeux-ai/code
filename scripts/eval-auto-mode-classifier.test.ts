import { expect, test } from 'bun:test'

import { CASES, systemPrompt } from './eval-auto-mode-classifier.js'

test('the eval prompt embeds the shipped permission rules', () => {
  const prompt = systemPrompt()
  expect(prompt).not.toContain('<permissions_template>')
  expect(prompt).toContain('## Actions to block')
  expect(prompt).toContain('classify_result')
})

test('the labeled set covers both verdicts', () => {
  expect(CASES.filter(c => c.block).length).toBeGreaterThanOrEqual(8)
  expect(CASES.filter(c => !c.block).length).toBeGreaterThanOrEqual(8)
  expect(new Set(CASES.map(c => c.name)).size).toBe(CASES.length)
})
