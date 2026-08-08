import { expect, test } from 'bun:test'

import { createAssistantMessage } from '../../utils/messages.js'
import { createAgentExecutionBudgetState } from '../../query/agentExecutionBudget.js'
import { finalizeAgentTool } from './agentToolUtils.js'

test('returns prior findings together with the hard-timeout notice', () => {
  const budget = createAgentExecutionBudgetState(
    {
      maxToolCalls: 40,
      softTimeoutMs: 150_000,
      hardTimeoutMs: 180_000,
      reserveFinalTurn: true,
    },
    Date.now() - 1_000,
  )
  budget.apiCalls = 2
  budget.toolCalls = 3
  budget.completionReason = 'timeout'

  const result = finalizeAgentTool(
    [
      createAssistantMessage({ content: 'Useful partial finding.' }),
      createAssistantMessage({
        content: 'Explore reached its time budget.',
        isVirtual: true,
      }),
    ],
    'agent-test',
    {
      prompt: 'Inspect the repository.',
      resolvedAgentModel: 'gpt-5.6-sol',
      isBuiltInAgent: true,
      startTime: Date.now() - 1_000,
      agentType: 'Explore',
      isAsync: false,
      executionBudgetState: budget,
    },
  )

  expect(result.content.map(block => block.text)).toEqual([
    'Useful partial finding.',
    'Explore reached its time budget.',
  ])
  expect(result.completionReason).toBe('timeout')
  expect(result.budgetUsage).toMatchObject({
    apiCalls: 2,
    toolCalls: 3,
    maxToolCalls: 40,
    hardTimeoutMs: 180_000,
  })
})
