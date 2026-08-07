/**
 * A single-flight queue shared by interactive browser turns and routines.
 */
export function createRunQueue() {
  const pending = []
  let active = null

  function enqueue(run) {
    if (!run?.id || typeof run.execute !== 'function') {
      return Promise.reject(new Error('run_queue_item_invalid'))
    }
    if (active?.id === run.id || pending.some((item) => item.id === run.id)) {
      return Promise.reject(new Error('run_queue_duplicate'))
    }

    return new Promise((resolve, reject) => {
      pending.push({ ...run, resolve, reject, cancelled: false })
      void pump()
    })
  }

  function cancel(id) {
    const index = pending.findIndex((item) => item.id === id)
    if (index >= 0) {
      const [item] = pending.splice(index, 1)
      item.cancelled = true
      item.reject(new Error('run_cancelled'))
      return true
    }
    if (active?.id === id) {
      active.cancelled = true
      active.cancel?.()
      return true
    }
    return false
  }

  function pause(id) {
    if (active?.id === id) {
      active.pause?.()
      return true
    }
    return pending.some((item) => item.id === id)
  }

  async function pump() {
    if (active || pending.length === 0) return
    active = pending.shift()
    try {
      const result = await active.execute()
      if (active.cancelled) {
        active.reject(new Error('run_cancelled'))
      } else {
        active.resolve(result)
      }
    } catch (error) {
      active.reject(error)
    } finally {
      active = null
      void pump()
    }
  }

  return {
    enqueue,
    cancel,
    pause,
    activeId: () => active?.id ?? null,
  }
}
