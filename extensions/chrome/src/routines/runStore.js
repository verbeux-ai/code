export const RUNS_STORAGE_KEY = 'verbooRoutineRunsV1'

const MAX_RUNS_PER_ACCOUNT = 50
const MAX_EVENTS_PER_RUN = 120
const VALID_STATUSES = new Set([
  'draft',
  'ready',
  'queued',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
])
const ALLOWED_TRANSITIONS = Object.freeze({
  draft: new Set(['ready', 'cancelled']),
  ready: new Set(['queued', 'cancelled']),
  queued: new Set(['running', 'cancelled']),
  running: new Set(['waiting_approval', 'queued', 'completed', 'failed', 'cancelled']),
  waiting_approval: new Set(['running', 'failed', 'cancelled']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
})

export function createRunStore(storage, now = Date.now) {
  if (!storage?.get || !storage?.set) throw new Error('routine_run_storage_unavailable')
  let writeTail = Promise.resolve()

  function transact(operation) {
    const result = writeTail.then(async () => {
      const all = await loadAll(storage)
      const output = await operation(all)
      await storage.set({ [RUNS_STORAGE_KEY]: all })
      return cloneValue(output)
    })
    writeTail = result.then(() => undefined, () => undefined)
    return result
  }

  async function afterWrites() {
    await writeTail.catch(() => {})
  }

  return {
    async list(accountId) {
      await afterWrites()
      const all = await loadAll(storage)
      return cloneValue(accountRuns(all, accountId))
        .sort((left, right) => right.updatedAt - left.updatedAt)
    },

    async get(accountId, id) {
      await afterWrites()
      const all = await loadAll(storage)
      const run = accountRuns(all, accountId).find((item) => item.id === id)
      return run ? cloneValue(run) : null
    },

    create(accountId, input) {
      return transact((all) => {
        const runs = accountRuns(all, accountId)
        if (!input?.id) throw new Error('routine_run_id_required')
        if (runs.some((run) => run.id === input.id)) {
          throw new Error('routine_run_duplicate')
        }
        if (
          input.occurrenceKey &&
          runs.some((run) => run.occurrenceKey === input.occurrenceKey)
        ) {
          throw new Error('routine_occurrence_duplicate')
        }
        const status = input.status ?? 'draft'
        if (!VALID_STATUSES.has(status)) throw new Error('routine_run_status_invalid')
        const timestamp = now()
        const run = {
          ...cloneValue(input),
          accountId: String(accountId),
          status,
          events: Array.isArray(input.events) ? cloneValue(input.events).slice(-MAX_EVENTS_PER_RUN) : [],
          checkpointIndex: Number.isInteger(input.checkpointIndex)
            ? input.checkpointIndex
            : 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        }
        runs.push(run)
        all[accountId] = boundRuns(runs)
        return run
      })
    },

    transition(accountId, id, nextStatus, patch = {}) {
      return transact((all) => {
        const runs = accountRuns(all, accountId)
        const index = runs.findIndex((item) => item.id === id)
        if (index === -1) throw new Error('routine_run_not_found')
        const current = runs[index]
        if (!ALLOWED_TRANSITIONS[current.status]?.has(nextStatus)) {
          throw new Error('routine_run_transition_invalid')
        }
        const updated = {
          ...current,
          ...cloneValue(patch),
          id: current.id,
          accountId: current.accountId,
          status: nextStatus,
          updatedAt: now(),
        }
        runs[index] = updated
        all[accountId] = boundRuns(runs)
        return updated
      })
    },

    patch(accountId, id, patch) {
      return transact((all) => {
        const runs = accountRuns(all, accountId)
        const index = runs.findIndex((item) => item.id === id)
        if (index === -1) throw new Error('routine_run_not_found')
        const current = runs[index]
        const updated = {
          ...current,
          ...cloneValue(patch),
          id: current.id,
          accountId: current.accountId,
          status: current.status,
          updatedAt: now(),
        }
        runs[index] = updated
        all[accountId] = boundRuns(runs)
        return updated
      })
    },

    appendEvent(accountId, id, event) {
      return transact((all) => {
        const runs = accountRuns(all, accountId)
        const index = runs.findIndex((item) => item.id === id)
        if (index === -1) throw new Error('routine_run_not_found')
        const current = runs[index]
        const nextEvent = {
          ...cloneValue(event),
          at: Number.isFinite(event?.at) ? event.at : now(),
        }
        const updated = {
          ...current,
          events: [...(Array.isArray(current.events) ? current.events : []), nextEvent]
            .slice(-MAX_EVENTS_PER_RUN),
          id: current.id,
          accountId: current.accountId,
          status: current.status,
          updatedAt: now(),
        }
        runs[index] = updated
        all[accountId] = boundRuns(runs)
        return updated
      })
    },

    recoverInterrupted(accountId) {
      return transact((all) => {
        const runs = accountRuns(all, accountId)
        const recovered = []
        for (let index = 0; index < runs.length; index += 1) {
          if (!['running', 'waiting_approval'].includes(runs[index].status)) continue
          runs[index] = {
            ...runs[index],
            status: 'queued',
            updatedAt: now(),
          }
          recovered.push(runs[index])
        }
        all[accountId] = boundRuns(runs)
        return recovered
      })
    },
  }
}

async function loadAll(storage) {
  const result = await storage.get(RUNS_STORAGE_KEY)
  const stored = result?.[RUNS_STORAGE_KEY]
  return stored && typeof stored === 'object' && !Array.isArray(stored)
    ? cloneValue(stored)
    : {}
}

function accountRuns(all, accountId) {
  const owner = String(accountId ?? '').trim()
  if (!owner) throw new Error('routine_account_required')
  return Array.isArray(all[owner]) ? all[owner] : []
}

function boundRuns(runs) {
  return [...runs]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_RUNS_PER_ACCOUNT)
}

function cloneValue(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value))
}
