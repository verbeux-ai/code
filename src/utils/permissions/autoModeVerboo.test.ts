/**
 * VERBOO-BRAND: auto mode behaves like Claude Code's — a classifier that is
 * down, slow or answers out of format asks the user instead of blocking, the
 * classifier runs on a dedicated router role, and the main model is told to
 * stop and wait after asking a question.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { resolve } from 'path'

import { classifierSideQuery } from './yoloClassifier.js'

const SRC = resolve(import.meta.dir, '../..')
const source = (relative: string) => Bun.file(resolve(SRC, relative)).text()
const savedTimeout = process.env.VERBOO_AUTO_MODE_TIMEOUT_MS

afterEach(() => {
  if (savedTimeout === undefined) delete process.env.VERBOO_AUTO_MODE_TIMEOUT_MS
  else process.env.VERBOO_AUTO_MODE_TIMEOUT_MS = savedTimeout
})

type Query = Parameters<typeof classifierSideQuery>[1]
const opts = { model: 'm', max_tokens: 1, messages: [], querySource: 'auto_mode' } as unknown as Parameters<typeof classifierSideQuery>[0]
const ok = { id: 'msg', content: [], usage: { input_tokens: 0, output_tokens: 0 } }

describe('classifierSideQuery', () => {
  test('retries once on a transient upstream error', async () => {
    let calls = 0
    const query = (async () => {
      calls += 1
      if (calls === 1) throw Object.assign(new Error('overloaded'), { status: 529 })
      return ok
    }) as unknown as Query
    expect(await classifierSideQuery(opts, query)).toBe(ok as never)
    expect(calls).toBe(2)
  })

  test('does not retry a client error and gives up after the second failure', async () => {
    let calls = 0
    const badRequest = (async () => {
      calls += 1
      throw Object.assign(new Error('bad request'), { status: 400 })
    }) as unknown as Query
    await expect(classifierSideQuery(opts, badRequest)).rejects.toThrow('bad request')
    expect(calls).toBe(1)

    calls = 0
    const alwaysDown = (async () => {
      calls += 1
      throw Object.assign(new Error('down'), { status: 503 })
    }) as unknown as Query
    await expect(classifierSideQuery(opts, alwaysDown)).rejects.toThrow('down')
    expect(calls).toBe(2)
  })

  test('a hung request times out and is retried once', async () => {
    process.env.VERBOO_AUTO_MODE_TIMEOUT_MS = '30'
    let calls = 0
    const hang = ((request: { signal?: AbortSignal }) => {
      calls += 1
      return new Promise((_, reject) => {
        request.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }) as unknown as Query
    await expect(classifierSideQuery(opts, hang)).rejects.toThrow('aborted')
    expect(calls).toBe(2)
  })

  test('a user abort is never retried', async () => {
    const controller = new AbortController()
    let calls = 0
    const query = (async () => {
      calls += 1
      controller.abort()
      throw new Error('user aborted')
    }) as unknown as Query
    await expect(
      classifierSideQuery({ ...opts, signal: controller.signal } as typeof opts, query),
    ).rejects.toThrow('user aborted')
    expect(calls).toBe(1)
  })
})

describe('auto mode wiring', () => {
  test('an unavailable classifier asks the user in interactive sessions', async () => {
    const content = await source('utils/permissions/permissions.ts')
    const branch = content.slice(content.indexOf('if (classifierResult.unavailable) {'))
    expect(branch).toContain('!appState.toolPermissionContext.shouldAvoidPermissionPrompts')
    expect(branch).toContain('Auto mode classifier unavailable — asking for manual approval')
    expect(branch.indexOf('asking for manual approval')).toBeLessThan(
      branch.indexOf("'tengu_iron_gate_closed'"),
    )
  })

  test('unparsable classifier answers are malfunctions, not verdicts', async () => {
    const content = await source('utils/permissions/yoloClassifier.ts')
    expect(content).not.toMatch(/unparseable - blocking for safety|no tool use block - blocking|Invalid classifier response - blocking/)
    const parts = content.split("reason: 'Classifier returned an unparsable response'")
    // tool_use path (no tool_use, invalid schema) + two-stage path (stage 1, stage 2)
    expect(parts).toHaveLength(5)
    for (const before of parts.slice(0, 4)) {
      expect(before.slice(-120)).toContain('unavailable: true')
    }
  })

  test('the classifier uses the router "classifier" role in Verboo mode', async () => {
    const content = await source('utils/permissions/yoloClassifier.ts')
    expect(content).toContain("getVerbooAgentModelForRole('classifier')")
    expect(await source('services/api/verbooModels.ts')).toContain("'classifier',")
  })

  test('the main model is told to wait after asking, not to execute immediately', async () => {
    const content = await source('utils/messages.ts')
    const start = content.indexOf('function getAutoModeFullInstructions')
    const instructions = content.slice(start, content.indexOf('function normalizeAttachmentForAPI'))
    expect(instructions).not.toContain('Execute immediately')
    expect(instructions).not.toContain('When in doubt, start coding')
    expect(instructions).toContain('A question ends your turn')
  })

  test('/config keeps "auto" as the default mode', async () => {
    const content = await source('components/Settings/Config.tsx')
    expect(content).toContain("parsedMode === 'auto' ? parsedMode")
  })
})
