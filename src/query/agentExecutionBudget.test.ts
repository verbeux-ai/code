import { expect, mock, test } from 'bun:test'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import {
  AGENT_BUDGET_TIMEOUT_REASON,
  createAgentExecutionBudgetState,
  createBudgetedCanUseTool,
  refreshAgentBudgetDeadline,
  shouldFinalizeAgentBudget,
  startAgentBudgetTimers,
} from './agentExecutionBudget.js'

function callBudgeted(canUseTool: CanUseToolFn, toolUseID: string) {
  return canUseTool(
    {} as never,
    {},
    {} as never,
    {} as never,
    toolUseID,
  )
}

test('admits each tool ID once and rejects calls beyond the cap', async () => {
  const base = mock(async (_tool, input) => ({
    behavior: 'allow' as const,
    updatedInput: input,
  })) as CanUseToolFn
  const state = createAgentExecutionBudgetState({
    maxToolCalls: 2,
    softTimeoutMs: 1_000,
    hardTimeoutMs: 2_000,
    reserveFinalTurn: true,
  })
  const budgeted = createBudgetedCanUseTool(base, state)

  const first = await callBudgeted(budgeted, 'call-1')
  const duplicate = await callBudgeted(budgeted, 'call-1')
  const second = await callBudgeted(budgeted, 'call-2')
  const overflow = await callBudgeted(budgeted, 'call-3')

  expect(first.behavior).toBe('allow')
  expect(duplicate.behavior).toBe('allow')
  expect(second.behavior).toBe('allow')
  expect(overflow).toMatchObject({
    behavior: 'deny',
    toolUseID: 'call-3',
  })
  expect(state.toolCalls).toBe(2)
  expect(state.completionReason).toBe('max_tool_calls')
  expect(base).toHaveBeenCalledTimes(2)
})

test('soft and hard deadlines are distinguished and hard timeout aborts only its controller', async () => {
  const state = createAgentExecutionBudgetState(
    {
      maxToolCalls: 40,
      softTimeoutMs: 10,
      hardTimeoutMs: 20,
      reserveFinalTurn: true,
    },
    1_000,
  )
  refreshAgentBudgetDeadline(state, 1_010)
  expect(state.softDeadlineReached).toBe(true)
  expect(state.hardDeadlineReached).toBe(false)

  const timedState = createAgentExecutionBudgetState({
    maxToolCalls: 40,
    softTimeoutMs: 5,
    hardTimeoutMs: 10,
    reserveFinalTurn: true,
  })
  const controller = new AbortController()
  const stop = startAgentBudgetTimers(timedState, controller)
  await Bun.sleep(25)
  stop()

  expect(timedState.hardDeadlineReached).toBe(true)
  expect(timedState.completionReason).toBe('timeout')
  expect(controller.signal.reason).toBe(AGENT_BUDGET_TIMEOUT_REASON)
})

test('reserves the fourth API turn for a tool-free final response', () => {
  const state = createAgentExecutionBudgetState({
    maxToolCalls: 40,
    softTimeoutMs: 150_000,
    hardTimeoutMs: 180_000,
    reserveFinalTurn: true,
  })

  state.apiCalls = 2
  expect(shouldFinalizeAgentBudget(state, 4)).toBe(false)
  state.apiCalls = 3
  expect(shouldFinalizeAgentBudget(state, 4)).toBe(true)
  state.finalizing = true
  expect(shouldFinalizeAgentBudget(state, 4)).toBe(false)
})
