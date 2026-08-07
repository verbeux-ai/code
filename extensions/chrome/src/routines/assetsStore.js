const MAX_ASSETS = 10
const MAX_TEXT_BYTES = 256 * 1024
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_TOTAL_BYTES = 10 * 1024 * 1024
const TEXT_MIMES = new Set([
  'text/markdown',
  'text/plain',
  'application/json',
  'text/csv',
])
const IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
])

export async function validateAsset(file, existingAssets = []) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    return { ok: false, error: 'asset_invalid' }
  }
  const mime = normalizeMime(file.type, file.name)
  if (!TEXT_MIMES.has(mime) && !IMAGE_MIMES.has(mime)) {
    return { ok: false, error: 'asset_type_not_allowed' }
  }
  if (existingAssets.length >= MAX_ASSETS) {
    return { ok: false, error: 'routine_asset_count_exceeded' }
  }
  const size = Number(file.size)
  const limit = IMAGE_MIMES.has(mime) ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES
  if (!Number.isFinite(size) || size < 0 || size > limit) {
    return { ok: false, error: 'asset_too_large' }
  }
  const total = existingAssets.reduce((sum, asset) => sum + Number(asset?.size ?? 0), 0)
  if (total + size > MAX_TOTAL_BYTES) {
    return { ok: false, error: 'routine_asset_total_exceeded' }
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  if (IMAGE_MIMES.has(mime) && !matchesImageSignature(mime, bytes)) {
    return { ok: false, error: 'asset_signature_mismatch' }
  }

  return {
    ok: true,
    asset: {
      name: sanitizeFilename(file.name),
      mime,
      size,
      data: IMAGE_MIMES.has(mime)
        ? new Blob([bytes], { type: mime })
        : new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/\r\n/g, '\n'),
    },
  }
}

export function createAssetsStore(
  adapter = createIndexedDbAssetsAdapter(),
  cryptoImpl = globalThis.crypto,
) {
  if (!cryptoImpl?.randomUUID) throw new Error('routine_asset_crypto_unavailable')

  return {
    async add(accountId, routineId, file) {
      const existing = await this.list(accountId, routineId)
      const validation = await validateAsset(file, existing)
      if (!validation.ok) throw new Error(validation.error)
      const record = {
        id: cryptoImpl.randomUUID(),
        accountId: requiredString(accountId, 'routine_account_required'),
        routineId: requiredString(routineId, 'routine_id_required'),
        ...validation.asset,
        createdAt: Date.now(),
      }
      await adapter.put(record)
      return metadata(record)
    },

    async list(accountId, routineId) {
      const records = await adapter.listByRoutine(routineId)
      return records
        .filter((record) => record.accountId === accountId)
        .map(metadata)
    },

    async get(accountId, id) {
      const record = await adapter.get(id)
      return record?.accountId === accountId ? record : null
    },

    async remove(accountId, id) {
      const record = await adapter.get(id)
      if (!record || record.accountId !== accountId) return false
      await adapter.delete(id)
      return true
    },

    async removeRoutineAssets(accountId, routineId) {
      const records = await adapter.listByRoutine(routineId)
      let removed = 0
      for (const record of records) {
        if (record.accountId !== accountId) continue
        await adapter.delete(record.id)
        removed += 1
      }
      return removed
    },
  }
}

export function createIndexedDbAssetsAdapter(indexedDb = globalThis.indexedDB) {
  if (!indexedDb) {
    return {
      put: async () => { throw new Error('routine_asset_storage_unavailable') },
      get: async () => null,
      listByRoutine: async () => [],
      delete: async () => {},
    }
  }

  const dbPromise = openDatabase(indexedDb)
  return {
    put: async (record) => runRequest(dbPromise, 'readwrite', (store) => store.put(record)),
    get: async (id) => runRequest(dbPromise, 'readonly', (store) => store.get(id)),
    listByRoutine: async (routineId) =>
      runRequest(dbPromise, 'readonly', (store) =>
        store.index('routineId').getAll(routineId)),
    delete: async (id) => runRequest(dbPromise, 'readwrite', (store) => store.delete(id)),
  }
}

function openDatabase(indexedDb) {
  return new Promise((resolve, reject) => {
    const request = indexedDb.open('verboo-routines', 1)
    request.onupgradeneeded = () => {
      const db = request.result
      const store = db.objectStoreNames.contains('assets')
        ? request.transaction.objectStore('assets')
        : db.createObjectStore('assets', { keyPath: 'id' })
      if (!store.indexNames.contains('accountId')) {
        store.createIndex('accountId', 'accountId', { unique: false })
      }
      if (!store.indexNames.contains('routineId')) {
        store.createIndex('routineId', 'routineId', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('routine_asset_storage_open_failed'))
  })
}

async function runRequest(dbPromise, mode, operation) {
  const db = await dbPromise
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('assets', mode)
    const request = operation(transaction.objectStore('assets'))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('routine_asset_storage_failed'))
  })
}

function normalizeMime(type, name) {
  const mime = String(type ?? '').toLowerCase()
  if (mime) return mime
  const extension = String(name ?? '').toLowerCase().split('.').pop()
  return {
    md: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json',
    csv: 'text/csv',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
  }[extension] ?? ''
}

function matchesImageSignature(mime, bytes) {
  if (mime === 'image/png') {
    return [137, 80, 78, 71, 13, 10, 26, 10]
      .every((value, index) => bytes[index] === value)
  }
  if (mime === 'image/jpeg') {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }
  if (mime === 'image/webp') {
    return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP'
  }
  return false
}

function ascii(bytes, start, end) {
  return String.fromCharCode(...bytes.slice(start, end))
}

function sanitizeFilename(value) {
  return String(value ?? 'asset')
    .replace(/[/\\\u0000-\u001f]/g, '_')
    .slice(0, 180)
}

function requiredString(value, error) {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(error)
  return text
}

function metadata(record) {
  const { data: _data, ...rest } = record
  return structuredClone(rest)
}
