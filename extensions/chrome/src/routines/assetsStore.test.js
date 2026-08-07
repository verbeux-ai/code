import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createAssetsStore,
  validateAsset,
} from './assetsStore.js'

function fakeFile(name, type, bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(bytes)
  return {
    name,
    type,
    size: data.byteLength,
    arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
  }
}

test('validates allowed text and image assets by size and signature', async () => {
  assert.equal(
    (await validateAsset(fakeFile('skill.md', 'text/markdown', new Uint8Array(262_144)))).ok,
    true,
  )
  assert.deepEqual(
    await validateAsset(fakeFile('large.txt', 'text/plain', new Uint8Array(262_145))),
    { ok: false, error: 'asset_too_large' },
  )
  assert.equal(
    (await validateAsset(fakeFile(
      'image.png',
      'image/png',
      Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
    ))).ok,
    true,
  )
  assert.deepEqual(
    await validateAsset(fakeFile('vector.svg', 'image/svg+xml', '<svg/>')),
    { ok: false, error: 'asset_type_not_allowed' },
  )
  assert.deepEqual(
    await validateAsset(fakeFile('page.html', 'text/html', '<h1>x</h1>')),
    { ok: false, error: 'asset_type_not_allowed' },
  )
  assert.deepEqual(
    await validateAsset(fakeFile('fake.png', 'image/png', '#!/bin/sh')),
    { ok: false, error: 'asset_signature_mismatch' },
  )
})

test('enforces per-routine count and total quotas', async () => {
  const existing = Array.from({ length: 10 }, (_, index) => ({
    id: String(index),
    size: 1,
  }))
  assert.deepEqual(
    await validateAsset(fakeFile('extra.txt', 'text/plain', 'x'), existing),
    { ok: false, error: 'routine_asset_count_exceeded' },
  )
  assert.deepEqual(
    await validateAsset(
      fakeFile('extra.txt', 'text/plain', 'x'),
      [{ id: 'large', size: 10 * 1024 * 1024 }],
    ),
    { ok: false, error: 'routine_asset_total_exceeded' },
  )
})

test('stores and removes assets only for their owning account', async () => {
  const records = new Map()
  const adapter = {
    put: async (record) => records.set(record.id, structuredClone(record)),
    get: async (id) => structuredClone(records.get(id) ?? null),
    listByRoutine: async (routineId) =>
      [...records.values()].filter((record) => record.routineId === routineId),
    delete: async (id) => records.delete(id),
  }
  let sequence = 0
  const store = createAssetsStore(adapter, {
    randomUUID: () => `asset-${++sequence}`,
  })

  const asset = await store.add(
    'acct-a',
    'routine-1',
    fakeFile('notes.txt', 'text/plain', 'hello'),
  )
  assert.equal((await store.list('acct-a', 'routine-1')).length, 1)
  assert.equal(await store.remove('acct-b', asset.id), false)
  assert.equal(await store.remove('acct-a', asset.id), true)
})
