const STORAGE_KEY = 'verbooRoutineDraftsV1'
const DEFAULT_TTL_MS = 30 * 60 * 1000

export function createTemporaryDraftStore(
  storage,
  cryptoImpl = globalThis.crypto,
  now = Date.now,
) {
  return {
    async save(accountId, draft, ttlMs = DEFAULT_TTL_MS) {
      const all = await load(storage, now())
      const id = cryptoImpl.randomUUID()
      all[id] = {
        id,
        accountId,
        draft: structuredClone(draft),
        expiresAt: now() + ttlMs,
      }
      await storage.set({ [STORAGE_KEY]: all })
      return all[id]
    },

    async get(accountId, id) {
      const all = await load(storage, now())
      const entry = all[id]
      if (!entry || entry.accountId !== accountId) return null
      delete all[id]
      await storage.set({ [STORAGE_KEY]: all })
      return structuredClone(entry.draft)
    },
  }
}

async function load(storage, currentTime) {
  const result = await storage.get(STORAGE_KEY)
  const stored = result?.[STORAGE_KEY]
  const all = stored && typeof stored === 'object' ? structuredClone(stored) : {}
  for (const [id, entry] of Object.entries(all)) {
    if (!entry || entry.expiresAt <= currentTime) delete all[id]
  }
  return all
}
