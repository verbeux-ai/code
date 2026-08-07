import { MSG } from '../controller/protocol.js'

const SUPPORTED_TYPES = new Set([
  MSG.ROUTINE_LIST,
  MSG.ROUTINE_GET,
  MSG.ROUTINE_CREATE,
  MSG.ROUTINE_UPDATE,
  MSG.ROUTINE_DUPLICATE,
  MSG.ROUTINE_DELETE,
])

/**
 * Create the service-worker boundary for account-scoped routine CRUD.
 *
 * @param {{
 *   store: ReturnType<import('./store.js').createRoutinesStore>,
 *   loadSession: () => Promise<{accountId?: string}|null>,
 *   broadcast: (message: object) => void,
 *   removeRoutineAssets?: (accountId: string, routineId: string) => Promise<unknown>,
 *   onRoutineChanged?: (routine: object, change: string) => Promise<object|undefined>,
 * }} dependencies
 */
export function createRoutineMessageHandler({
  store,
  loadSession,
  broadcast,
  removeRoutineAssets,
  onRoutineChanged,
}) {
  return async function handleRoutineMessage(message) {
    if (!SUPPORTED_TYPES.has(message?.type)) {
      return { ok: false, error: 'routine_message_unsupported' }
    }

    try {
      const session = await loadSession()
      const accountId = String(session?.accountId ?? '').trim()
      if (!accountId) return { ok: false, error: 'auth_required' }

      switch (message.type) {
        case MSG.ROUTINE_LIST:
          return { ok: true, routines: await store.list(accountId) }

        case MSG.ROUTINE_GET:
          return { ok: true, routine: await store.get(accountId, message.id) }

        case MSG.ROUTINE_CREATE: {
          let routine = await store.create(accountId, message.draft)
          routine = await applyChange(routine, 'created')
          broadcastChanged(routine, 'created')
          return { ok: true, routine }
        }

        case MSG.ROUTINE_UPDATE: {
          let routine = await store.update(
            accountId,
            message.id,
            message.expectedRevision,
            message.patch,
          )
          routine = await applyChange(routine, 'updated')
          broadcastChanged(routine, 'updated')
          return { ok: true, routine }
        }

        case MSG.ROUTINE_DUPLICATE: {
          let routine = await store.duplicate(accountId, message.id)
          routine = await applyChange(routine, 'duplicated')
          broadcastChanged(routine, 'duplicated')
          return { ok: true, routine }
        }

        case MSG.ROUTINE_DELETE: {
          const routine = await store.get(accountId, message.id)
          const removed = await store.remove(accountId, message.id)
          if (removed) {
            await removeRoutineAssets?.(accountId, message.id).catch(() => {})
            await applyChange(
              routine ?? { id: message.id, accountId },
              'deleted',
            )
            broadcast({
              type: MSG.ROUTINE_STATE_CHANGED,
              change: 'deleted',
              routineId: message.id,
            })
          }
          return { ok: true, removed }
        }

        default:
          return { ok: false, error: 'routine_message_unsupported' }
      }
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) }
    }
  }

  async function applyChange(routine, change) {
    const changed = await onRoutineChanged?.(routine, change)
    return changed ?? routine
  }

  function broadcastChanged(routine, change) {
    broadcast({
      type: MSG.ROUTINE_STATE_CHANGED,
      change,
      routine,
    })
  }
}
