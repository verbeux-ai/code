export async function replayRecordedSteps({
  steps,
  startIndex = 0,
  execute,
  checkpoint,
  signal,
}) {
  const list = Array.isArray(steps) ? steps : []
  let completedSteps = 0

  for (let index = startIndex; index < list.length; index += 1) {
    if (signal?.aborted) throw new Error('run_cancelled')
    const step = list[index]
    const toolCall = {
      id: crypto.randomUUID(),
      name: step.name,
      params: structuredClone(step.params ?? {}),
      reasoning: 'Replaying a user-recorded routine step.',
    }
    const result = await execute(toolCall)
    if (signal?.aborted) throw new Error('run_cancelled')
    if (!result?.ok) {
      const error = String(result?.error ?? 'recorded_step_failed').slice(0, 500)
      if (isTerminalReplayError(error, result?.policy)) throw new Error(error)
      return {
        status: 'needs_recovery',
        nextIndex: index,
        completedSteps,
        failure: {
          index,
          step: structuredClone(step),
          semantic: structuredClone(step.semantic ?? {}),
          error,
        },
      }
    }
    completedSteps += 1
    await checkpoint(index + 1)
  }

  return {
    status: 'completed',
    nextIndex: list.length,
    completedSteps,
  }
}

function isTerminalReplayError(error, policy) {
  return [
    'denied_by_user',
    'cancelled',
    'timeout',
    'site_denied',
    'hard_block',
  ].some((code) => error === code || policy?.reason === code)
}
