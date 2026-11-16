import { expect, test } from 'bun:test'

import { BANNED_PATTERNS, findBannedPatterns } from './verify-no-phone-home.js'

test('reports every banned pattern with its count', () => {
  const contents = `fetch("https://http-intake.logs.datadoghq.com"); x = "datadoghq.com"; infra.ant.dev`
  expect(findBannedPatterns(contents)).toEqual([
    { pattern: 'datadoghq.com', count: 2 },
    { pattern: 'infra.ant.dev', count: 1 },
  ])
})

test('a clean bundle passes', () => {
  expect(findBannedPatterns('const router = "https://code.verboo.ai/router/v1"')).toEqual([])
  expect(BANNED_PATTERNS.length).toBeGreaterThan(0)
})
