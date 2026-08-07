import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createRoutineRunner } from './runner.js'
import { createRunQueue } from './runQueue.js'

function baseRoutine(overrides = {}) {
  return {
    id: 'routine-1',
    accountId: 'acct-a',
    revision: 2,
    name: 'Weekly',
    instructions: 'Open the dashboard for {{empresa}}.',
    variables: [{ name: 'empresa', required: true, defaultValue: '' }],
    assets: [],
    allowedOrigins: ['https://example.com'],
    recordedSteps: [],
    ...overrides,
  }
}

function createHarness(overrides = {}) {
  const transitions = []
  let runSequence = 0
  const storedRuns = new Map()
  const dependencies = {
    routinesStore: {
      get: async () => baseRoutine(),
    },
      runStore: {
      create: async (accountId, input) => {
        const run = { ...input, accountId, status: 'draft', events: input.events ?? [] }
        storedRuns.set(run.id, run)
        return run
      },
      transition: async (_accountId, id, status, patch = {}) => {
        const run = { ...storedRuns.get(id), ...patch, status }
        storedRuns.set(id, run)
        transitions.push(status)
        return run
      },
      get: async (_accountId, id) => storedRuns.get(id) ?? null,
      patch: async (_accountId, id, patch) => {
        const run = { ...storedRuns.get(id), ...patch }
        storedRuns.set(id, run)
        return run
      },
      appendEvent: async (_accountId, id, event) => {
        const run = storedRuns.get(id)
        run.events = [...(run.events ?? []), event]
        storedRuns.set(id, run)
        return run
      },
    },
    queue: createRunQueue(),
    loadSession: async () => ({ accountId: 'acct-a', accessToken: 'token' }),
    loadModels: async () => [{ id: 'visual-model', supportsVision: true }],
    getSelectedModelId: async () => 'visual-model',
    getActiveTabMeta: async () => ({ url: 'https://example.com/dashboard' }),
    runAgent: async (input) => ({
      assistantMessage: input.routineContext.instructions,
      toolResults: [],
    }),
    broadcast: () => {},
    cryptoImpl: { randomUUID: () => `run-${++runSequence}` },
    ...overrides,
  }
  return {
    runner: createRoutineRunner(dependencies),
    transitions,
    storedRuns,
  }
}

test('resolves variables into a user-owned routine context and completes', async () => {
  let agentInput
  const { runner, transitions } = createHarness({
    runAgent: async (input) => {
      agentInput = input
      return { assistantMessage: 'Done', toolResults: [] }
    },
  })

  const result = await runner.run({
    routineId: 'routine-1',
    expectedRevision: 2,
    variables: { empresa: 'Acme' },
  })

  assert.equal(result.status, 'completed')
  assert.deepEqual(transitions, ['ready', 'queued', 'running', 'completed'])
  assert.equal(agentInput.routineContext.name, 'Weekly')
  assert.equal(agentInput.routineContext.instructions, 'Open the dashboard for Acme.')
})

test('replays recorded steps before using semantic recovery', async () => {
  const executed = []
  let agentCalls = 0
  const { runner, storedRuns } = createHarness({
    routinesStore: {
      get: async () => baseRoutine({
        startUrl: 'https://example.com/dashboard',
        recordedSteps: [
          {
            name: 'click',
            params: { selector: '#old' },
            semantic: { accessibleName: 'Continue' },
          },
        ],
      }),
    },
    executeRecordedStep: async (toolCall) => {
      executed.push(toolCall)
      if (toolCall.name === 'navigate') return { ok: true, result: {} }
      return { ok: false, error: 'element_not_found:#old' }
    },
    getActiveTabMeta: async () => ({ url: 'https://example.com/other' }),
    runAgent: async (input) => {
      agentCalls += 1
      assert.deepEqual(input.toolAllowlist, ['click', 'read_page', 'screenshot'])
      return {
        assistantMessage: 'Recovered.',
        toolResults: [
          {
            name: 'click',
            params: { selector: 'button.continue' },
            success: true,
          },
        ],
      }
    },
  })

  const result = await runner.run({
    routineId: 'routine-1',
    expectedRevision: 2,
    variables: { empresa: 'Acme' },
  })

  assert.equal(result.status, 'completed')
  assert.deepEqual(executed.map((call) => call.name), ['navigate', 'click'])
  assert.equal(agentCalls, 1)
  assert.equal(
    storedRuns.get(result.id).recoverySuggestion.params.selector,
    'button.continue',
  )
})

test('resumes an interrupted recorded routine from its last confirmed checkpoint', async () => {
  const executed = []
  const { runner, storedRuns } = createHarness({
    routinesStore: {
      get: async () => baseRoutine({
        recordedSteps: [
          { name: 'click', params: { selector: '#confirmed' } },
          { name: 'click', params: { selector: '#remaining' } },
        ],
      }),
    },
    executeRecordedStep: async (toolCall) => {
      executed.push(toolCall)
      return { ok: true, result: {} }
    },
  })
  storedRuns.set('run-resume', {
    id: 'run-resume',
    accountId: 'acct-a',
    routineId: 'routine-1',
    routineRevision: 2,
    modelId: 'visual-model',
    variables: { empresa: 'Acme' },
    checkpointIndex: 1,
    status: 'queued',
  })

  const result = await runner.resume('acct-a', 'run-resume')

  assert.equal(result.status, 'completed')
  assert.deepEqual(
    executed.map((toolCall) => toolCall.params.selector),
    ['#remaining'],
  )
})

test('simulation completes with a visible plan and never calls browser execution', async () => {
  let agentCalls = 0
  const events = []
  const { runner } = createHarness({
    runAgent: async () => {
      agentCalls += 1
      return { assistantMessage: 'should not run', toolResults: [] }
    },
    broadcast: (message) => {
      if (message?.run?.events) events.push(message.run.events.at(-1))
    },
  })

  const result = await runner.run({
    routineId: 'routine-1',
    expectedRevision: 2,
    variables: { empresa: 'Acme' },
    simulate: true,
  })

  assert.equal(result.status, 'completed')
  assert.equal(result.simulation, true)
  assert.match(result.assistantMessage, /Simulation only/)
  assert.equal(agentCalls, 0)
  assert.ok(events.some((event) => event?.type === 'simulation'))
})

test('simulation does not require an inference model', async () => {
  const { runner } = createHarness({
    getSelectedModelId: async () => null,
    loadModels: async () => [],
  })

  const result = await runner.run({
    routineId: 'routine-1',
    expectedRevision: 2,
    variables: { empresa: 'Acme' },
    simulate: true,
  })

  assert.equal(result.status, 'completed')
  assert.equal(result.simulation, true)
})

test('simulation exposes conditionals, sub-routines, and structured extraction', async () => {
  const events = []
  const { runner } = createHarness({
    routinesStore: {
      get: async () => baseRoutine({
        branch: {
          selector: '.status',
          contains: 'Ready',
          thenInstructions: 'Publish it.',
          elseInstructions: 'Wait.',
        },
        subroutineCommands: ['collect-leads'],
        output: { format: 'json', selector: 'table' },
      }),
      list: async () => [
        baseRoutine({ id: 'routine-1', command: 'weekly' }),
        baseRoutine({ id: 'routine-2', command: 'collect-leads', instructions: 'Collect the leads.' }),
      ],
    },
    broadcast: (message) => {
      if (message?.run?.events) events.push(message.run.events.at(-1))
    },
  })

  const result = await runner.run({
    routineId: 'routine-1',
    expectedRevision: 2,
    variables: { empresa: 'Acme' },
    simulate: true,
  })

  assert.equal(result.status, 'completed')
  assert.equal(events.at(-1)?.type, 'simulation')
  assert.deepEqual(
    events.at(-1).steps.map((step) => step.name),
    ['conditional', 'agent', 'subroutine', 'structured_extract'],
  )
})

for (const [name, override, request, code] of [
  [
    'missing auth',
    { loadSession: async () => null },
    { routineId: 'routine-1', expectedRevision: 2, variables: { empresa: 'Acme' } },
    'auth_required',
  ],
  [
    'stale routine',
    {},
    { routineId: 'routine-1', expectedRevision: 1, variables: { empresa: 'Acme' } },
    'routine_revision_conflict',
  ],
  [
    'missing variable',
    {},
    { routineId: 'routine-1', expectedRevision: 2, variables: {} },
    'routine_variable_missing',
  ],
  [
    'missing model',
    { getSelectedModelId: async () => null },
    { routineId: 'routine-1', expectedRevision: 2, variables: { empresa: 'Acme' } },
    'routine_model_missing',
  ],
  [
    'non-visual model with image asset',
    {
      routinesStore: {
        get: async () => baseRoutine({ assets: [{ id: 'asset-1', mime: 'image/png' }] }),
      },
      loadModels: async () => [{ id: 'text-model', supportsVision: false }],
      getSelectedModelId: async () => 'text-model',
    },
    { routineId: 'routine-1', expectedRevision: 2, variables: { empresa: 'Acme' } },
    'routine_model_requires_vision',
  ],
  [
    'site outside allowlist',
    { getActiveTabMeta: async () => ({ url: 'https://other.example/page' }) },
    { routineId: 'routine-1', expectedRevision: 2, variables: { empresa: 'Acme' } },
    'routine_site_not_allowed',
  ],
]) {
  test(`preflight rejects ${name}`, async () => {
    const { runner } = createHarness(override)
    await assert.rejects(runner.run(request), new RegExp(code))
  })
}
