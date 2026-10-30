import { describe, expect, test } from 'bun:test'

import { parseModelJsonObject } from './modelJson.js'

describe('parseModelJsonObject', () => {
  test('reads a bare object', () => {
    expect(parseModelJsonObject('{"ok": true}')).toEqual({ ok: true })
  })

  test('ignores reasoning, fences and surrounding prose', () => {
    expect(parseModelJsonObject('<think>is it met? {"ok": false}</think>\n```json\n{"ok": true}\n```')).toEqual({ ok: true })
    expect(parseModelJsonObject('Sure! Here is the result: {"ok": false, "reason": "tests fail {see log}"} Hope it helps.')).toEqual({
      ok: false,
      reason: 'tests fail {see log}',
    })
  })

  test('returns null without an object', () => {
    expect(parseModelJsonObject('')).toBeNull()
    expect(parseModelJsonObject('yes')).toBeNull()
    expect(parseModelJsonObject('[1, 2]')).toBeNull()
    expect(parseModelJsonObject('{not json}')).toBeNull()
  })
})
