import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { PermissionDecision } from '../utils/permissions/PermissionResult.js'

export const AGENT_BUDGET_TIMEOUT_REASON = 'agent_execution_budget_timeout'

export type AgentCompletionReason =
  | 'completed'
  | 'max_turns'
  | 'max_tool_calls'
  | 'timeout'

export type AgentExecutionBudgetConfig = {
  maxToolCalls: number
  softTimeoutMs: number
  hardTimeoutMs: number
  reserveFinalTurn: boolean
}

export type AgentExecutionBudgetState = {
  config: AgentExecutionBudgetConfig
  startedAt: number
  apiCalls: number
  toolCalls: number
  admittedToolUseIds: Set<string>
  decisions: Map<string, Promise<PermissionDecision>>
  completionReason?: Exclude<AgentCompletionReason, 'completed'>
  softDeadlineReached: boolean
  hardDeadlineReached: boolean
  finalizing: boolean
}

export function createAgentExecutionBudgetState(
  config: AgentExecutionBudgetConfig,
  startedAt: number = Date.now(),
): AgentExecutionBudgetState {
  return {
    config,
    startedAt,
    apiCalls: 0,
    toolCalls: 0,
    admittedToolUseIds: new Set(),
    decisions: new Map(),
    softDeadlineReached: false,
    hardDeadlineReached: false,
    finalizing: false,
  }
}

export function markAgentBudgetCompletion(
  state: AgentExecutionBudgetState,
  reason: Exclude<AgentCompletionReason, 'completed'>,
): void {
  if (reason === 'timeout' || state.completionReason === undefined) {
    state.completionReason = reason
  }
}

export function refreshAgentBudgetDeadline(
  state: AgentExecutionBudgetState,
  now: number = Date.now(),
): void {
  const elapsed = now - state.startedAt
  if (elapsed >= state.config.softTimeoutMs) {
    state.softDeadlineReached = true
    markAgentBudgetCompletion(state, 'timeout')
  }
  if (elapsed >= state.config.hardTimeoutMs) {
    state.hardDeadlineReached = true
    markAgentBudgetCompletion(state, 'timeout')
  }
}

export function startAgentBudgetTimers(
  state: AgentExecutionBudgetState,
  abortController: AbortController,
): () => void {
  refreshAgentBudgetDeadline(state)
  const elapsed = Date.now() - state.startedAt
  const softTimer = state.softDeadlineReached
    ? undefined
    : setTimeout(() => {
        state.softDeadlineReached = true
        markAgentBudgetCompletion(state, 'timeout')
      }, Math.max(0, state.config.softTimeoutMs - elapsed))
  const hardTimer = state.hardDeadlineReached
    ? undefined
    : setTimeout(() => {
        state.hardDeadlineReached = true
        markAgentBudgetCompletion(state, 'timeout')
        abortController.abort(AGENT_BUDGET_TIMEOUT_REASON)
      }, Math.max(0, state.config.hardTimeoutMs - elapsed))

  if (state.hardDeadlineReached && !abortController.signal.aborted) {
    abortController.abort(AGENT_BUDGET_TIMEOUT_REASON)
  }

  return () => {
    if (softTimer) clearTimeout(softTimer)
    if (hardTimer) clearTimeout(hardTimer)
  }
}

export function isAgentBudgetTimeout(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason === AGENT_BUDGET_TIMEOUT_REASON
}

/**
 * Applies one admission policy to both streaming and non-streaming execution.
 * The existing permission/tool pipeline still creates the terminal tool_result.
 */
export function createBudgetedCanUseTool(
  canUseTool: CanUseToolFn,
  state: AgentExecutionBudgetState,
): CanUseToolFn {
  return async (
    tool,
    input,
    toolUseContext,
    assistantMessage,
    toolUseID,
    forceDecision,
  ) => {
    const previous = state.decisions.get(toolUseID)
    if (previous) return previous

    refreshAgentBudgetDeadline(state)
    const decision = (async (): Promise<PermissionDecision> => {
      if (state.softDeadlineReached || state.hardDeadlineReached) {
        markAgentBudgetCompletion(state, 'timeout')
        return {
          behavior: 'deny',
          message:
            'Explore time budget reached. This tool call was not executed; summarize the findings collected so far.',
          decisionReason: {
            type: 'asyncAgent',
            reason: 'execution_time_budget',
          },
          toolUseID,
        }
      }

      if (state.toolCalls >= state.config.maxToolCalls) {
        markAgentBudgetCompletion(state, 'max_tool_calls')
        return {
          behavior: 'deny',
          message:
            'Explore tool budget reached. This tool call was not executed; summarize the findings collected so far.',
          decisionReason: {
            type: 'asyncAgent',
            reason: 'execution_tool_budget',
          },
          toolUseID,
        }
      }

      state.toolCalls++
      state.admittedToolUseIds.add(toolUseID)
      return canUseTool(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseID,
        forceDecision,
      )
    })()

    state.decisions.set(toolUseID, decision)
    return decision
  }
}

export function getAgentBudgetUsage(state: AgentExecutionBudgetState): {
  apiCalls: number
  toolCalls: number
  elapsedMs: number
  maxToolCalls: number
  hardTimeoutMs: number
} {
  return {
    apiCalls: state.apiCalls,
    toolCalls: state.toolCalls,
    elapsedMs: Date.now() - state.startedAt,
    maxToolCalls: state.config.maxToolCalls,
    hardTimeoutMs: state.config.hardTimeoutMs,
  }
}

export function shouldFinalizeAgentBudget(
  state: AgentExecutionBudgetState,
  maxTurns: number | undefined,
): boolean {
  if (state.finalizing) return false
  const shouldReserveFinalTurn =
    state.config.reserveFinalTurn &&
    maxTurns !== undefined &&
    state.apiCalls >= maxTurns - 1
  return (
    state.completionReason === 'max_tool_calls' ||
    state.softDeadlineReached ||
    shouldReserveFinalTurn
  )
}
