import { nextOccurrence, occurrenceKey } from './recurrence.js'

export const ROUTINE_ALARM_PREFIX = 'verboo-routine:'

/**
 * Chrome-alarm scheduler for account-scoped routines.
 */
export function createScheduler({
  routinesStore,
  loadSession,
  ensureFreshSession,
  getSelectedModelId,
  loadModels,
  getNormalWindow,
  createRunTab,
  runRoutine,
  occurrenceExists = async () => false,
  loadMode = async () => 'skip',
  getSiteGrant = async () => undefined,
  alarms,
  notify,
  now = Date.now,
}) {
  async function handleAlarm(alarm) {
    const identity = parseAlarmName(alarm?.name)
    if (!identity) return { status: 'ignored', reason: 'unknown_alarm' }

    const routine = await routinesStore.get(identity.accountId, identity.routineId)
    if (!routine?.schedule?.enabled) {
      await alarms.clear(alarm.name)
      return { status: 'ignored', reason: 'schedule_disabled' }
    }

    const scheduledAt = Number(routine.schedule.nextRunAt)
    const nextRunAt = nextOccurrence(
      routine.schedule,
      Math.max(now(), Number.isFinite(scheduledAt) ? scheduledAt : 0),
    )
    const updated = await routinesStore.update(
      identity.accountId,
      routine.id,
      routine.revision,
      {
        schedule: {
          ...routine.schedule,
          nextRunAt,
        },
      },
    )
    alarms.create(alarmName(updated), { when: nextRunAt })
    const scheduledOccurrenceKey = occurrenceKey(updated.id, scheduledAt)
    if (await occurrenceExists(identity.accountId, scheduledOccurrenceKey)) {
      return { status: 'ignored', reason: 'routine_occurrence_duplicate' }
    }

    const session = await loadSession()
    if (
      !session?.accessToken ||
      String(session?.accountId ?? '') !== identity.accountId
    ) {
      return pause(updated, 'account_mismatch')
    }

    const freshSession = await ensureFreshSession()
    if (
      !freshSession?.accessToken ||
      String(freshSession?.accountId ?? '') !== identity.accountId
    ) {
      return pause(updated, 'auth_required')
    }

    const variables = resolveScheduledVariables(updated.variables)
    if (!variables.ok) return pause(updated, variables.reason)

    const modelId = updated.modelId || await getSelectedModelId()
    const models = await loadModels(false)
    const model = models.find((item) => item.id === modelId)
    if (!model) return pause(updated, 'routine_model_missing')
    if (routineNeedsVision(updated) && model.supportsVision !== true) {
      return pause(updated, 'routine_model_requires_vision')
    }

    if (!scheduledSiteAllowed(updated)) {
      return pause(updated, 'routine_site_not_allowed')
    }
    const siteGrant = await getSiteGrant(new URL(updated.startUrl).hostname)
    const mode = await loadMode()
    if (siteGrant === 'deny') return pause(updated, 'site_denied')
    if (mode === 'manual' && siteGrant !== 'always') {
      return pause(updated, 'routine_approval_required')
    }

    const normalWindow = await getNormalWindow()
    if (!normalWindow?.id) return pause(updated, 'normal_window_unavailable')
    const tab = await createRunTab(updated.startUrl, normalWindow)
    if (!tab?.id) return pause(updated, 'run_tab_unavailable')

    await runRoutine({
      routineId: updated.id,
      expectedRevision: updated.revision,
      variables: variables.values,
      modelId,
      senderTabId: tab.id,
      source: 'scheduled',
      occurrenceKey: scheduledOccurrenceKey,
      waitForCompletion: false,
    })
    return { status: 'queued', routine: updated }
  }

  async function upsert(accountId, routineId, schedule, expectedRevision) {
    const routine = await routinesStore.get(accountId, routineId)
    if (!routine) throw new Error('routine_not_found')
    if (
      expectedRevision != null &&
      routine.revision !== Number(expectedRevision)
    ) {
      throw new Error('routine_revision_conflict')
    }

    if (!schedule?.enabled) return remove(accountId, routineId)
    const nextRunAt = Number(schedule.nextRunAt) > now()
      ? Number(schedule.nextRunAt)
      : nextOccurrence(schedule, now())
    const updated = await routinesStore.update(
      accountId,
      routineId,
      routine.revision,
      {
        schedule: {
          ...schedule,
          enabled: true,
          nextRunAt,
        },
      },
    )
    alarms.create(alarmName(updated), { when: nextRunAt })
    return updated
  }

  async function remove(accountId, routineId, expectedRevision) {
    const routine = await routinesStore.get(accountId, routineId)
    await alarms.clear(alarmName({ id: routineId, accountId }))
    if (!routine) return null
    if (
      expectedRevision != null &&
      routine.revision !== Number(expectedRevision)
    ) {
      throw new Error('routine_revision_conflict')
    }
    return routinesStore.update(accountId, routineId, routine.revision, {
      schedule: undefined,
    })
  }

  async function syncAccount(accountId) {
    const routines = await routinesStore.list(accountId)
    const scheduled = []
    for (const routine of routines) {
      if (!routine.schedule?.enabled) continue
      const currentTime = now()
      const storedNextRunAt = Number(routine.schedule.nextRunAt)
      if (Number.isFinite(storedNextRunAt) && storedNextRunAt <= currentTime) {
        alarms.create(alarmName(routine), { when: currentTime + 1_000 })
        scheduled.push(routine)
        continue
      }
      const nextRunAt = storedNextRunAt > currentTime
        ? storedNextRunAt
        : nextOccurrence(routine.schedule, currentTime)
      let current = routine
      if (nextRunAt !== routine.schedule.nextRunAt) {
        current = await routinesStore.update(
          accountId,
          routine.id,
          routine.revision,
          { schedule: { ...routine.schedule, nextRunAt } },
        )
      }
      alarms.create(alarmName(current), { when: nextRunAt })
      scheduled.push(current)
    }
    return scheduled
  }

  async function suspendAccount(accountId) {
    const routines = await routinesStore.list(accountId)
    await Promise.all(
      routines.map((routine) => alarms.clear(alarmName(routine))),
    )
  }

  async function reconcileRoutine(routine, change) {
    if (!routine?.id || !routine?.accountId) return routine
    if (change === 'deleted') {
      await alarms.clear(alarmName(routine))
      return routine
    }
    if (!routine.schedule?.enabled) {
      await alarms.clear(alarmName(routine))
      return routine
    }
    return upsert(routine.accountId, routine.id, routine.schedule)
  }

  async function pause(routine, reason) {
    await notify({
      id: routine.id,
      routineId: routine.id,
      title: routine.name,
      message: reason,
      reason,
    })
    return { status: 'paused', reason, routine }
  }

  return {
    handleAlarm,
    upsert,
    remove,
    syncAccount,
    suspendAccount,
    reconcileRoutine,
  }
}

export function alarmName(routine) {
  return `${ROUTINE_ALARM_PREFIX}${routine.id}:${routine.accountId}`
}

export function parseAlarmName(name) {
  const value = String(name ?? '')
  if (!value.startsWith(ROUTINE_ALARM_PREFIX)) return null
  const identity = value.slice(ROUTINE_ALARM_PREFIX.length)
  const separator = identity.indexOf(':')
  if (separator <= 0 || separator === identity.length - 1) return null
  return {
    routineId: identity.slice(0, separator),
    accountId: identity.slice(separator + 1),
  }
}

function resolveScheduledVariables(variables) {
  const values = {}
  for (const variable of variables ?? []) {
    const value = String(variable?.defaultValue ?? '')
    if (variable?.required !== false && value.trim() === '') {
      return {
        ok: false,
        reason: `routine_variable_missing:${variable?.name ?? ''}`,
      }
    }
    values[variable.name] = value
  }
  return { ok: true, values }
}

function routineNeedsVision(routine) {
  return (routine.assets ?? []).some((asset) =>
    String(asset?.mime ?? asset?.type ?? '').startsWith('image/'),
  )
}

function scheduledSiteAllowed(routine) {
  if (!routine.startUrl || !(routine.allowedOrigins ?? []).length) return false
  try {
    return routine.allowedOrigins.includes(new URL(routine.startUrl).origin)
  } catch {
    return false
  }
}
