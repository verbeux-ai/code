import { normalizeRoutineDraft } from './schema.js'

export const ROUTINES_STORAGE_KEY = 'verbooRoutinesV1'

/**
 * Deep persistence module for account-scoped routine CRUD.
 *
 * @param {{get: Function, set: Function}} storage
 * @param {{randomUUID: () => string}} [cryptoImpl]
 * @param {() => number} [now]
 */
export function createRoutinesStore(
  storage,
  cryptoImpl = globalThis.crypto,
  now = Date.now,
) {
  if (!storage?.get || !storage?.set) throw new Error('routine_storage_unavailable')
  if (!cryptoImpl?.randomUUID) throw new Error('routine_crypto_unavailable')

  let writeTail = Promise.resolve()

  async function afterPendingWrites() {
    await writeTail.catch(() => {})
  }

  function transact(operation) {
    const result = writeTail.then(async () => {
      const all = await loadAll(storage)
      const output = await operation(all)
      await storage.set({ [ROUTINES_STORAGE_KEY]: all })
      return cloneValue(output)
    })
    writeTail = result.then(() => undefined, () => undefined)
    return result
  }

  return {
    async list(accountId) {
      await afterPendingWrites()
      const all = await loadAll(storage)
      return cloneValue(accountRoutines(all, accountId))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    },

    async get(accountId, id) {
      await afterPendingWrites()
      const all = await loadAll(storage)
      const found = accountRoutines(all, accountId).find((routine) => routine.id === id)
      return found ? cloneValue(found) : null
    },

    create(accountId, draft) {
      return transact((all) => {
        const timestamp = now()
        const routines = accountRoutines(all, accountId)
        const routine = normalizeRoutineDraft(draft, accountId, {
          id: cryptoImpl.randomUUID(),
          updatedAt: timestamp,
        })
        assertUniqueCommand(routines, routine.command)
        routines.push(routine)
        all[accountId] = routines
        return routine
      })
    },

    update(accountId, id, expectedRevision, patch) {
      return transact((all) => {
        const routines = accountRoutines(all, accountId)
        const index = routines.findIndex((routine) => routine.id === id)
        if (index === -1) throw new Error('routine_not_found')
        const current = routines[index]
        if (current.revision !== expectedRevision) {
          throw new Error('routine_revision_conflict')
        }
        const updated = normalizeRoutineDraft(
          { ...current, ...cloneValue(patch), id: current.id, accountId: current.accountId },
          accountId,
          {
            id: current.id,
            revision: current.revision + 1,
            createdAt: current.createdAt,
            updatedAt: now(),
          },
        )
        assertUniqueCommand(routines, updated.command, current.id)
        routines[index] = updated
        all[accountId] = routines
        return updated
      })
    },

    duplicate(accountId, id) {
      return transact((all) => {
        const routines = accountRoutines(all, accountId)
        const current = routines.find((routine) => routine.id === id)
        if (!current) throw new Error('routine_not_found')
        const timestamp = now()
        const command = nextCopyCommand(routines, current.command)
        const routine = normalizeRoutineDraft(
          {
            ...cloneValue(current),
            name: `${current.name} copy`,
            command,
            schedule: undefined,
          },
          accountId,
          {
            id: cryptoImpl.randomUUID(),
            revision: 1,
            updatedAt: timestamp,
          },
        )
        routines.push(routine)
        all[accountId] = routines
        return routine
      })
    },

    remove(accountId, id) {
      return transact((all) => {
        const routines = accountRoutines(all, accountId)
        const next = routines.filter((routine) => routine.id !== id)
        if (next.length === routines.length) return false
        all[accountId] = next
        return true
      })
    },
  }
}

async function loadAll(storage) {
  const result = await storage.get(ROUTINES_STORAGE_KEY)
  const stored = result?.[ROUTINES_STORAGE_KEY]
  return stored && typeof stored === 'object' && !Array.isArray(stored)
    ? cloneValue(stored)
    : {}
}

function accountRoutines(all, accountId) {
  const owner = String(accountId ?? '').trim()
  if (!owner) throw new Error('routine_account_required')
  return Array.isArray(all[owner]) ? all[owner] : []
}

function assertUniqueCommand(routines, command, exceptId) {
  if (routines.some((routine) => routine.id !== exceptId && routine.command === command)) {
    throw new Error('routine_command_conflict')
  }
}

function nextCopyCommand(routines, sourceCommand) {
  const base = `${sourceCommand.slice(0, 59)}-copy`
  if (!routines.some((routine) => routine.command === base)) return base
  let suffix = 2
  let candidate = withNumericSuffix(base, suffix)
  while (routines.some((routine) => routine.command === candidate)) {
    suffix += 1
    candidate = withNumericSuffix(base, suffix)
  }
  return candidate
}

function withNumericSuffix(base, suffix) {
  const ending = `-${suffix}`
  return `${base.slice(0, 64 - ending.length)}${ending}`
}

function cloneValue(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value))
}
