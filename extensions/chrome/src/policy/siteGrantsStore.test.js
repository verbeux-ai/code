/**
 * siteGrantsStore.test.js — Unit tests for site grant persistence.
 *
 * Run with: node --test src/policy/siteGrantsStore.test.js
 *
 * NOTE: chrome.storage.local is not available in Node.js.
 * These tests run against an in-memory shim that mirrors the API.
 */

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// In-memory storage shim
const fakeStore = {}
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => ({ [key]: fakeStore[key] ?? null }),
      set: async (obj) => { Object.assign(fakeStore, obj) },
      remove: async (key) => { delete fakeStore[key] },
    },
  },
}

const { loadGrants, upsertGrant, removeGrant, getGrant, saveGrants } = await import('./siteGrantsStore.js')

beforeEach(() => {
  Object.keys(fakeStore).forEach((k) => delete fakeStore[k])
})

test('loadGrants: returns empty array when no grants stored', async () => {
  const grants = await loadGrants()
  assert.deepEqual(grants, [])
})

test('upsertGrant: adds a new grant', async () => {
  const g = await upsertGrant('example.com', 'always')
  assert.equal(g.host, 'example.com')
  assert.equal(g.decision, 'always')
  assert.ok(typeof g.updatedAt === 'number')
})

test('upsertGrant: updates existing grant', async () => {
  await upsertGrant('example.com', 'once')
  const g = await upsertGrant('example.com', 'always')
  assert.equal(g.decision, 'always')
  const all = await loadGrants()
  assert.equal(all.length, 1)
})

test('removeGrant: removes a grant', async () => {
  await upsertGrant('example.com', 'always')
  await removeGrant('example.com')
  const all = await loadGrants()
  assert.deepEqual(all, [])
})

test('getGrant: returns undefined for unknown host', async () => {
  const d = await getGrant('unknown.com')
  assert.equal(d, undefined)
})

test('getGrant: returns decision for known host', async () => {
  await upsertGrant('example.com', 'deny')
  const d = await getGrant('example.com')
  assert.equal(d, 'deny')
})

test('saveGrants: replaces all grants', async () => {
  await saveGrants([{ host: 'a.com', decision: 'always', updatedAt: 1 }])
  const all = await loadGrants()
  assert.equal(all.length, 1)
  assert.equal(all[0].host, 'a.com')
})
