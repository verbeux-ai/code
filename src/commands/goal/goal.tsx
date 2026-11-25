import type { LocalJSXCommandCall } from '../../types/command.js'
import { prepareInteractiveProductFeature } from '../../services/productAnalytics/runtime.js'
import { getGlobalConfig } from '../../utils/config.js'
import {
  clearSessionGoal,
  createSessionGoal,
  getSessionGoal,
  startSessionGoal,
  setSessionGoalStatus,
  type SessionGoal,
} from '../../utils/goals.js'

function formatGoal(goal: SessionGoal): string {
  const status = goal.status === 'complete' ? 'completed' : goal.status
  const blocker =
    goal.status === 'blocked' && goal.blocker?.reason
      ? `\nBlocker: ${goal.blocker.reason}`
      : ''
  return `Current goal (${status}):\n${goal.objective}${blocker}`
}

function usage(): string {
  return [
    'Usage:',
    '  /goal <objective>  Set or replace a persistent goal and start working on it',
    '  /goal              Show the current goal',
    '  /goal status       Show the current goal',
    '  /goal complete     Mark the current goal complete',
    '  /goal pause        Pause the current goal',
    '  /goal resume       Resume a paused or blocked goal',
    '  /goal clear        Remove the current goal',
  ].join('\n')
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const input = args.trim()
  const [action, ...rest] = input.split(/\s+/)
  const normalizedAction = action?.toLowerCase()
  const isSingleAction = rest.length === 0

  if (
    !input ||
    (isSingleAction &&
      (normalizedAction === 'status' || normalizedAction === 'show'))
  ) {
    const goal = getSessionGoal()
    onDone(
      goal
        ? formatGoal(goal)
        : `No goal is set for this session.\n\n${usage()}`,
      { display: 'system' },
    )
    return null
  }

  if (
    isSingleAction &&
    (normalizedAction === 'help' || normalizedAction === '--help')
  ) {
    onDone(usage(), { display: 'system' })
    return null
  }

  if (
    isSingleAction &&
    (normalizedAction === 'set' || normalizedAction === 'start')
  ) {
    onDone(usage(), { display: 'system' })
    return null
  }

  if (
    isSingleAction &&
    ['clear', 'stop', 'off', 'reset', 'none', 'cancel'].includes(
      normalizedAction ?? '',
    )
  ) {
    const observeGoal = prepareInteractiveProductFeature('goal', getGlobalConfig().oauthAccount?.accountUuid ?? '')
    let goal: SessionGoal | null
    try {
      goal = clearSessionGoal()
    } catch (error) {
      observeGoal?.('failed')
      onDone(error instanceof Error ? error.message : String(error), {
        display: 'system',
      })
      return null
    }
    if (goal) observeGoal?.('completed')
    onDone(
      goal
        ? `Goal cleared:\n${goal.objective}`
        : 'No goal is set for this session.',
      { display: 'system' },
    )
    return null
  }

  if (
    isSingleAction &&
    (normalizedAction === 'complete' ||
      normalizedAction === 'pause' ||
      normalizedAction === 'resume')
  ) {
    const observeGoal = prepareInteractiveProductFeature('goal', getGlobalConfig().oauthAccount?.accountUuid ?? '')
    const status =
      normalizedAction === 'complete'
        ? 'complete'
        : normalizedAction === 'pause'
          ? 'paused'
          : 'active'
    let goal: SessionGoal | null
    try {
      goal = setSessionGoalStatus(status)
    } catch (error) {
      observeGoal?.('failed')
      onDone(error instanceof Error ? error.message : String(error), {
        display: 'system',
      })
      return null
    }
    if (goal) observeGoal?.('completed')
    if (!goal) {
      const current = getSessionGoal()
      const message = current?.status === 'complete'
        ? 'This goal is already complete. Set a new goal with /goal <objective>.'
        : 'No goal is set for this session.'
      onDone(message, { display: 'system' })
      return null
    }

    const result = normalizedAction === 'resume'
      ? `Goal resumed:\n${goal.objective}`
      : normalizedAction === 'pause'
        ? `Goal paused:\n${goal.objective}`
        : `Goal marked complete:\n${goal.objective}`
    const shouldQuery = normalizedAction === 'resume'
    onDone(result, {
      display: 'system',
      shouldQuery,
      ...(shouldQuery
        ? {
            metaMessages: [
              `The user resumed this persistent goal. Continue working toward it: ${JSON.stringify(goal.objective)}`,
            ],
          }
        : {}),
    })
    return null
  }

  const objective =
    (normalizedAction === 'set' || normalizedAction === 'start') && rest.length > 0
      ? rest.join(' ')
      : input
  if (!objective.trim()) {
    onDone(usage(), { display: 'system' })
    return null
  }

  const observeGoal = prepareInteractiveProductFeature('goal', getGlobalConfig().oauthAccount?.accountUuid ?? '')
  try {
    const previous = getSessionGoal()
    const goal = previous
      ? startSessionGoal(objective)
      : createSessionGoal(objective)
    const hadUnfinishedGoal = previous && previous.status !== 'complete'
    const sameObjective = previous?.objective === goal.objective
    const result = !hadUnfinishedGoal
      ? `Goal set:\n${goal.objective}`
      : sameObjective && previous.status === 'active'
        ? `Goal already active; continuing:\n${goal.objective}`
        : sameObjective
          ? `Goal resumed:\n${goal.objective}`
          : `Goal replaced:\n${goal.objective}`
    observeGoal?.('completed')
    onDone(result, {
      display: 'system',
      shouldQuery: true,
      metaMessages: [
        `The user set or resumed this persistent goal for the current session. Work toward it across turns until it is complete or the user pauses or clears it: ${JSON.stringify(goal.objective)}`,
      ],
    })
  } catch (error) {
    observeGoal?.('failed')
    onDone(error instanceof Error ? error.message : String(error), {
      display: 'system',
    })
  }
  return null
}
