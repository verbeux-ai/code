/**
 * Apply one user-approved semantic recovery to the exact routine revision that
 * produced it. The routine is never rewritten automatically.
 */
export async function applyRecoverySuggestion({
  accountId,
  runId,
  runStore,
  routinesStore,
  now = Date.now,
}) {
  const run = await runStore.get(accountId, runId)
  if (!run?.recoverySuggestion) throw new Error('routine_recovery_suggestion_missing')
  const suggestion = run.recoverySuggestion
  const routine = await routinesStore.get(accountId, run.routineId)
  if (!routine) throw new Error('routine_not_found')
  if (routine.revision !== suggestion.expectedRoutineRevision) {
    throw new Error('routine_revision_conflict')
  }

  const stepIndex = Number(suggestion.stepIndex)
  if (
    !Number.isInteger(stepIndex) ||
    stepIndex < 0 ||
    stepIndex >= (routine.recordedSteps ?? []).length
  ) {
    throw new Error('routine_recovery_suggestion_invalid')
  }

  const recordedSteps = structuredClone(routine.recordedSteps)
  recordedSteps[stepIndex] = {
    ...recordedSteps[stepIndex],
    name: suggestion.name,
    params: structuredClone(suggestion.params),
  }
  const updatedRoutine = await routinesStore.update(
    accountId,
    routine.id,
    routine.revision,
    { recordedSteps },
  )
  const updatedRun = await runStore.patch(accountId, run.id, {
    recoverySuggestion: null,
    recoverySuggestionAppliedAt: now(),
  })
  return { routine: updatedRoutine, run: updatedRun }
}
