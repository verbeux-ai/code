import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProductAnalyticsClient } from './client.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const userA = '10000000-0000-4000-8000-000000000001'
const userB = '20000000-0000-4000-8000-000000000002'
const jwt = (sub: string) => `header.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`
const subject = (user: string) => createHash('sha256').update('user:' + user).digest('hex')

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'verboo-cli-product-'))
  roots.push(root)
  let user = userA, failEvents = false, failConsent = false, wrongReceipt = false
  let decidedAt = '2020-01-01T00:00:00Z'
  let now = Date.parse('2026-11-17T12:00:00Z'), serverNow = now
  let serverOrder = 9007199254740992n // Above Number.MAX_SAFE_INTEGER.
  let includeOrder = true
  let grantGate: Promise<void> | undefined
  let grantReached: (() => void) | undefined
  const events: Array<{ token: string; raw: string }> = []
  const primingHeaders: Headers[] = []
  const decisions = new Map([[subject(userA), { decision: 'unknown', revision: 0, decisionOrder: '0' }], [subject(userB), { decision: 'unknown', revision: 0, decisionOrder: '0' }]])
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const token = new Headers(init?.headers).get('Authorization')?.slice(7) ?? ''
    if (!token && String(input).endsWith('/product-consent')) {
      primingHeaders.push(new Headers(init?.headers))
      const order = String(++serverOrder)
      return Response.json({ data: { serverTime: new Date(serverNow).toISOString(), ...(includeOrder ? { serverOrder: order, serverProof: `v1.${order}.${'a'.repeat(64)}` } : {}) } })
    }
    const actor = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { sub: string }
    const id = subject(actor.sub)
    if (String(input).endsWith('/product-consent')) {
      if (failConsent) throw new Error('offline')
      let state = decisions.get(id)!
      if (init?.method === 'PUT') {
        const requested = JSON.parse(String(init.body)) as { decision: string; revision: number }
        if (requested.decision === 'granted' && grantGate) { grantReached?.(); await grantGate }
        state = decisions.get(id)!
        if (requested.revision !== state.revision) return new Response('{}', { status: 409 })
        state = { decision: requested.decision, revision: state.revision + 1, decisionOrder: String(++serverOrder) }; decisions.set(id, state)
      }
      const order = String(++serverOrder)
      return Response.json({ data: { subjectId: id, ...state, policyVersion: 1,
        decidedAt, expiresAt: '2099-01-01T00:00:00Z', enabled: true, serverTime: new Date(serverNow).toISOString(),
        ...(includeOrder ? { serverOrder: order, serverProof: `v1.${order}.${'a'.repeat(64)}` } : {}) } })
    }
    const raw = String(init?.body), event = JSON.parse(raw) as { eventId: string }
    events.push({ token, raw })
    if (failEvents) throw new Error('offline')
    return Response.json({ data: { status: 'accepted', receipt: { eventId: event.eventId,
      payloadSha256: wrongReceipt ? 'f'.repeat(64) : createHash('sha256').update(raw).digest('hex') } } }, { status: 202 })
  }
  const newClient = () => new ProductAnalyticsClient({ root, apiOrigin: 'http://127.0.0.1:1234', appVersion: '1.2.3', token: async () => jwt(user), fetch, now: () => now, os: 'linux' })
  const client = newClient()
  return { root, client, newClient, events, primingHeaders, decisions, setUser: (v: string) => { user = v }, setFailEvents: (v: boolean) => { failEvents = v },
    setGrantGate: (gate: Promise<void>, reached: () => void) => { grantGate = gate; grantReached = reached },
    setFailConsent: (v: boolean) => { failConsent = v }, setWrongReceipt: (v: boolean) => { wrongReceipt = v },
    setDecidedAt: (v: string) => { decidedAt = v }, advance: (ms: number) => { now += ms },
    advanceServer: (ms: number) => { serverNow += ms }, setIncludeOrder: (v: boolean) => { includeOrder = v },
    setServerOrder: (v: bigint) => { serverOrder = v } }
}
async function settle() { await new Promise(resolve => setTimeout(resolve, 50)) }

describe('CLI product analytics', () => {
  test('obtains an anonymous time reference without sending a usage event', async () => {
    const f = await fixture()
    await f.client.primeCheckpoint()
    expect(f.client.captureCheckpoint()).toEqual({ order: 9007199254740993n, serverTime: Date.parse('2026-11-17T12:00:00Z'), proof: `v1.9007199254740993.${'a'.repeat(64)}` })
    expect(f.primingHeaders[0]?.get('Authorization')).toBeNull()
    expect(f.primingHeaders[0]?.get('X-Verboo-Analytics-Scope')).toMatch(/^[a-f0-9]{64}$/)
    expect(f.events).toHaveLength(0)
  })

  test('requires an explicit account grant and keeps prompt content out of the event', async () => {
    const f = await fixture()
    expect(await f.client.beginTurn('private-local-id', undefined, undefined, f.client.captureCheckpoint())).toBeUndefined()
    await f.client.choose('granted')
    const turn = (await f.client.beginTurn('private-local-id', undefined, undefined, f.client.captureCheckpoint()))!
    f.advance(500)
    await f.client.completeTurn(turn, 'external')
    await settle()
    expect(f.events).toHaveLength(1)
    const sent = JSON.parse(f.events[0]!.raw)
    expect(sent).toMatchObject({ name: 'product_response_completed', surface: 'cli', modality: 'external', outcome: 'completed', durationMs: 500 })
    expect(f.events[0]!.raw).not.toContain('private-local-id')
    expect(Object.keys(sent).sort()).toEqual(['appVersion','consentRevision','consentProof','durationMs','eventId','modality','name','occurredAt','operationId','os','outcome','schemaVersion','surface'].sort())
  })

  test('retains original bytes on failure and never borrows another account token', async () => {
    const f = await fixture()
    await f.client.choose('granted')
    const turn = (await f.client.beginTurn('turn-a', undefined, undefined, f.client.captureCheckpoint()))!
    f.setFailEvents(true)
    await f.client.completeTurn(turn, 'verboo_gateway')
    await settle()
    expect(f.events).toHaveLength(1)
    f.setUser(userB)
    await f.client.choose('granted')
    f.setFailEvents(false)
    await f.client.flush()
    expect(f.events).toHaveLength(1)
    f.setUser(userA)
    f.setWrongReceipt(true)
    await f.client.flush()
    expect(f.events).toHaveLength(2)
    f.setWrongReceipt(false)
    await f.client.flush()
    expect(f.events).toHaveLength(3)
    expect(f.events.every(event => event.token === jwt(userA) && event.raw === f.events[0]!.raw)).toBe(true)
    expect((await readdir(join(f.root, 'product-analytics-v1', subject(userA)))).filter(name => /^[0-9a-f-]{36}\.json$/i.test(name))).toHaveLength(0)
  })

  test('revocation blocks locally while offline and prevents old queued events from reappearing', async () => {
    const f = await fixture()
    await f.client.choose('granted')
    const turn = (await f.client.beginTurn('turn-a', undefined, undefined, f.client.captureCheckpoint()))!
    f.setFailEvents(true)
    await f.client.completeTurn(turn, 'verboo_gateway')
    await settle()
    expect(f.events).toHaveLength(1)
    f.setFailConsent(true)
    await expect(f.client.choose('denied')).rejects.toThrow()
    await settle()
    await f.client.completeTurn(turn, 'verboo_gateway')
    f.setFailConsent(false)
    expect((await f.client.status())?.decision).toBe('denied')
    f.setFailEvents(false)
    await f.client.choose('granted')
    await f.client.flush()
    expect(f.events).toHaveLength(1)
  })
  test('synchronizes an offline refusal before a later grant', async () => {
    const f = await fixture()
    await f.client.choose('granted')
    const oldTurn = (await f.client.beginTurn('old-turn', undefined, undefined, f.client.captureCheckpoint()))!
    f.setFailConsent(true)
    await expect(f.client.choose('denied')).rejects.toThrow()
    f.setFailConsent(false)
    const granted = await f.client.choose('granted')
    expect(granted.decision).toBe('granted')
    expect(granted.revision).toBe(3)
    await f.client.completeTurn(oldTurn, 'external')
    await settle()
    expect(f.events).toHaveLength(0)
  })

  test('does not start an observation under a different initiating account', async () => {
    const f = await fixture()
    await f.client.choose('granted')
    f.setUser(userB)
    await f.client.choose('granted')
    expect(await f.client.beginTurn('turn-for-a', Date.parse('2026-11-17T12:00:00Z'), userA, f.client.captureCheckpoint())).toBeUndefined()
    expect(f.events).toHaveLength(0)
  })

  test('keeps an offline turn under the last confirmed grant and retries it when online', async () => {
    const f = await fixture()
    await f.client.choose('granted')
    f.setFailConsent(true)
    const turn = (await f.client.beginTurn('offline-turn', undefined, undefined, f.client.captureCheckpoint()))!
    f.advance(900)
    await f.client.completeTurn(turn, 'external')
    await settle()
    expect(f.events).toHaveLength(0)
    f.setFailConsent(false)
    await f.client.flush()
    expect(f.events).toHaveLength(1)
    expect(JSON.parse(f.events[0]!.raw).durationMs).toBe(900)
  })

  test('a newer refusal wins over a concurrent pending grant', async () => {
    const f = await fixture()
    let release!: () => void
    let reached!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { reached = resolve })
    f.setGrantGate(pending, reached)
    const allow = f.client.choose('granted')
    await started
    await f.client.choose('denied')
    release()
    await expect(allow).rejects.toThrow()
    expect((await f.client.status())?.decision).toBe('denied')
    expect(await f.client.beginTurn('after-race', undefined, undefined, f.client.captureCheckpoint())).toBeUndefined()
  })

  test('records interactive opens and login only after a prior account grant', async () => {
    const f = await fixture()
    const at = Date.parse('2026-11-17T12:00:00Z')
    await f.client.observeOpen(at, userA, f.client.captureCheckpoint())
    await f.client.observeLogin(at, userA, f.client.captureCheckpoint())
    await settle()
    expect(f.events).toHaveLength(0)
    await f.client.choose('granted')
    await f.client.observeOpen(at, userA, f.client.captureCheckpoint())
    await f.client.observeLogin(at, userA, f.client.captureCheckpoint())
    await settle()
    const events = f.events.map(item => JSON.parse(item.raw))
    expect(events.map(event => event.name).sort()).toEqual(['product_first_open_observed', 'product_login_completed', 'product_opened'])
    for (const event of events) expect(Object.keys(event).sort()).toEqual(['appVersion','consentRevision','consentProof','eventId','name','occurredAt','os','schemaVersion','surface'].sort())
    await f.client.observeOpen(at, userA, f.client.captureCheckpoint())
    await f.client.observeLogin(at, userB, f.client.captureCheckpoint())
    await settle()
    expect(f.events.filter(item => JSON.parse(item.raw).name === 'product_first_open_observed')).toHaveLength(1)
    expect(f.events.filter(item => JSON.parse(item.raw).name === 'product_opened')).toHaveLength(2)
    expect(f.events.filter(item => JSON.parse(item.raw).name === 'product_login_completed')).toHaveLength(1)
  })

  test('recovers an interrupted first-open marker without changing the queued event', async () => {
    const f = await fixture()
    const at = Date.parse('2026-11-17T12:00:00Z')
    await f.client.choose('granted')
    f.setFailEvents(true)
    await f.client.observeOpen(at, userA, f.client.captureCheckpoint())
    await settle()
    const original = f.events.find(item => JSON.parse(item.raw).name === 'product_first_open_observed')!.raw
    await unlink(join(f.root, 'product-analytics-v1', subject(userA), 'first-open'))
    f.setFailEvents(false)
    const attemptedBeforeRecovery = f.events.filter(item => JSON.parse(item.raw).name === 'product_first_open_observed').length
    await f.client.flush()
    expect(f.events.filter(item => JSON.parse(item.raw).name === 'product_first_open_observed')).toHaveLength(attemptedBeforeRecovery)
    f.advance(1000)
    await f.client.observeOpen(at + 1000, userA, f.client.captureCheckpoint())
    await settle()
    const firstOpens = f.events.filter(item => JSON.parse(item.raw).name === 'product_first_open_observed')
    expect(firstOpens.length).toBeGreaterThanOrEqual(2)
    expect(firstOpens.every(item => item.raw === original)).toBe(true)
  })

  test('concurrent processes share one first-open observation per local account', async () => {
    const f = await fixture()
    const at = Date.parse('2026-11-17T12:00:00Z')
    await f.client.choose('granted')
    const second = f.newClient()
    await second.status()
    await Promise.all([f.client.observeOpen(at, userA, f.client.captureCheckpoint()), second.observeOpen(at, userA, second.captureCheckpoint())])
    await settle()
    const firstOpens = f.events.map(item => JSON.parse(item.raw)).filter(event => event.name === 'product_first_open_observed')
    expect(new Set(firstOpens.map(event => event.eventId)).size).toBe(1)
  })

  test('does not retroactively observe an open or login before the grant', async () => {
    const f = await fixture()
    const at = Date.parse('2026-11-17T12:00:00Z')
    await f.client.choose('granted')
    f.setDecidedAt('2026-11-17T12:00:00Z')
    await f.client.observeOpen(at - 1000, userA, f.client.captureCheckpoint())
    await f.client.observeLogin(at - 1000, userA, f.client.captureCheckpoint())
    await settle()
    expect(f.events).toHaveLength(0)
  })

  test('does not borrow a later grant when the device clock is ahead', async () => {
    const f = await fixture()
    await f.client.primeCheckpoint()
    const checkpoint = f.client.captureCheckpoint()
    f.advanceServer(1000)
    f.advance(60_000)
    f.setDecidedAt('2026-11-17T11:59:00Z') // A different backend clock appears earlier than the reference.
    await f.client.choose('granted')
    const at = Date.parse('2026-11-17T12:01:00Z')
    await f.client.observeOpen(at, userA, checkpoint)
    await f.client.observeLogin(at, userA, checkpoint)
    expect(await f.client.beginTurn('turn', at, userA, checkpoint)).toBeUndefined()
    await settle()
    expect(f.events).toHaveLength(0)
  })

  test('does not borrow a server reference received after an action started', async () => {
    const f = await fixture()
    const checkpoint = f.client.captureCheckpoint()
    await f.client.choose('granted')
    await f.client.primeCheckpoint()
    const at = Date.parse('2026-11-17T12:00:00Z')
    await f.client.observeOpen(at, userA, checkpoint)
    await f.client.observeLogin(at, userA, checkpoint)
    expect(await f.client.beginTurn('turn', at, userA, checkpoint)).toBeUndefined()
    await settle()
    expect(f.events).toHaveLength(0)
  })

  test('an older response without an ordered reference clears the checkpoint', async () => {
    const f = await fixture()
    await f.client.choose('granted')
    expect(f.client.captureCheckpoint()).toBeDefined()
    f.setIncludeOrder(false)
    await f.client.status()
    const checkpoint = f.client.captureCheckpoint()
    expect(checkpoint).toBeUndefined()
    const at = Date.parse('2026-11-17T12:00:00Z')
    await f.client.observeOpen(at, userA, checkpoint)
    await f.client.observeLogin(at, userA, checkpoint)
    expect(await f.client.beginTurn('turn', at, userA, checkpoint)).toBeUndefined()
    await settle()
    expect(f.events).toHaveLength(0)
  })

  test('discards an unproved legacy first-open and permits a new observation', async () => {
    const f = await fixture()
    await f.client.choose('granted')
    const dir = join(f.root, 'product-analytics-v1', subject(userA))
    const legacyId = '30000000-0000-4000-8000-000000000003'
    await writeFile(join(dir, legacyId + '.json'), JSON.stringify({ schemaVersion: 1, eventId: legacyId,
      name: 'product_first_open_observed', consentRevision: 1, occurredAt: '2026-11-17T12:00:00Z',
      surface: 'cli', os: 'linux', appVersion: '1.2.3' }))
    await writeFile(join(dir, 'first-open'), legacyId)
    await f.client.flush()
    expect((await readdir(dir)).includes(legacyId + '.json')).toBe(false)
    expect((await readdir(dir)).includes('first-open')).toBe(false)
    expect(f.events).toHaveLength(0)
    await f.client.observeOpen(Date.parse('2026-11-17T12:00:00Z'), userA, f.client.captureCheckpoint())
    await settle()
    expect(f.events.some(item => JSON.parse(item.raw).name === 'product_first_open_observed')).toBe(true)
  })

  test('does not accept an ordered reference outside PostgreSQL bigint range', async () => {
    const f = await fixture()
    f.setServerOrder(9223372036854775807n)
    await f.client.primeCheckpoint()
    expect(f.client.captureCheckpoint()).toBeUndefined()
    expect(f.events).toHaveLength(0)
  })

  test('does not capture a proof whose embedded order differs from the reference', async () => {
    const f = await fixture()
    const fetch = (async () => Response.json({ data: { serverTime: '2026-11-17T12:00:00Z', serverOrder: '11',
      serverProof: `v1.12.${'a'.repeat(64)}` } })) as typeof globalThis.fetch
    const client = new ProductAnalyticsClient({ root: f.root, apiOrigin: 'http://127.0.0.1:1234', appVersion: '1.2.3',
      token: async () => undefined, fetch })
    await client.primeCheckpoint()
    expect(client.captureCheckpoint()).toBeUndefined()
  })

  test('does not revive a queued first open after offline refusal and a new grant', async () => {
    const f = await fixture()
    const at = Date.parse('2026-11-17T12:00:00Z')
    await f.client.choose('granted')
    f.setFailEvents(true)
    await f.client.observeOpen(at, userA, f.client.captureCheckpoint())
    await settle()
    const before = f.events.filter(item => JSON.parse(item.raw).name === 'product_first_open_observed').length
    f.setFailConsent(true)
    await expect(f.client.choose('denied')).rejects.toThrow()
    f.setFailConsent(false)
    f.setFailEvents(false)
    await f.client.choose('granted')
    f.advance(1000)
    await f.client.observeOpen(at + 1000, userA, f.client.captureCheckpoint())
    await settle()
    expect(f.events.filter(item => JSON.parse(item.raw).name === 'product_first_open_observed')).toHaveLength(before)
  })

})
