/** Consented, account-scoped product measurements for the interactive CLI. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { lock } from '../../utils/lockfile.js'

type Decision = 'unknown' | 'granted' | 'denied'
export type ProductConsent = { subjectId: string; decision: Decision; revision: number; policyVersion: 1; decidedAt: string; expiresAt: string; enabled: boolean; decisionOrder?: string }
type EventBase = { schemaVersion: 1; eventId: string; consentRevision: number; consentProof: string; occurredAt: string;
  surface: 'cli'; os: 'macos' | 'windows' | 'linux' | 'other'; appVersion: string }
type ResponseEvent = EventBase & { name: 'product_response_completed'; operationId: string;
  modality: 'verboo_gateway' | 'external'; outcome: 'completed'; durationMs: number }
type LifecycleEvent = EventBase & { name: 'product_opened' | 'product_first_open_observed' | 'product_login_completed' }
type Queued = ResponseEvent | LifecycleEvent
export type ProductTurn = { subjectId: string; consent: ProductConsent; startedAt: number; operationId: string; consentProof: string }
/** A server reference already received before an observed action began. */
export type ProductCheckpoint = Readonly<{ order: bigint; serverTime: number; proof: string }> | undefined
export type ProductClientOptions = { root: string; apiOrigin: string; appVersion: string; token: () => Promise<string | undefined>;
  fetch?: typeof globalThis.fetch; now?: () => number; os?: Queued['os'] }

const hex64 = /^[a-f0-9]{64}$/
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const eventKeys = ['schemaVersion','eventId','name','consentRevision','consentProof','occurredAt','surface','os','appVersion','operationId','modality','outcome','durationMs'].sort().join(',')
const lifecycleKeys = ['schemaVersion','eventId','name','consentRevision','consentProof','occurredAt','surface','os','appVersion'].sort().join(',')
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

function positiveOrder(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value)) return undefined
  const order = BigInt(value)
  return order <= 9223372036854775807n ? order : undefined
}

function subjectForToken(token: string): string | undefined {
  try {
    const payload: unknown = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
    const sub = (payload as { sub?: unknown })?.sub
    return typeof sub === 'string' && uuid.test(sub) ? sha('user:' + sub.toLowerCase()) : undefined
  } catch { return undefined }
}
function validConsent(value: unknown, expected: string): value is ProductConsent {
  if (!value || typeof value !== 'object') return false
  const c = value as ProductConsent
  return c.subjectId === expected && ['unknown','granted','denied'].includes(c.decision) && Number.isSafeInteger(c.revision) && c.revision >= 0 &&
    c.policyVersion === 1 && typeof c.enabled === 'boolean' && Number.isFinite(Date.parse(c.decidedAt)) && Number.isFinite(Date.parse(c.expiresAt))
}
function validEvent(value: unknown): value is Queued {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const e = value as Queued
  const common = e.schemaVersion === 1 && uuid.test(e.eventId) &&
    Number.isSafeInteger(e.consentRevision) && e.consentRevision > 0 && /^v1\.[1-9][0-9]{0,18}\.[a-f0-9]{64}$/.test(e.consentProof) && Number.isFinite(Date.parse(e.occurredAt)) && e.surface === 'cli' &&
    ['macos','windows','linux','other'].includes(e.os) && /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(e.appVersion)
  if (!common) return false
  if (e.name !== 'product_response_completed') return ['product_opened','product_first_open_observed','product_login_completed'].includes(e.name) && Object.keys(e).sort().join(',') === lifecycleKeys
  return Object.keys(e).sort().join(',') === eventKeys && uuid.test(e.operationId) &&
    ['verboo_gateway','external'].includes(e.modality) && e.outcome === 'completed' && Number.isSafeInteger(e.durationMs) && e.durationMs >= 0 && e.durationMs <= 604800000
}
function operationId(localId: string): string {
  const bytes = createHash('sha256').update('verboo-cli-response:1:' + localId).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 15) | 80
  bytes[8] = (bytes[8]! & 63) | 128
  const hex = bytes.toString('hex')
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
}

/** The collector is the consent authority; the CLI never receives a PostHog key. */
export class ProductAnalyticsClient {
  private readonly fetch: typeof globalThis.fetch
  private readonly now: () => number
  private readonly os: Queued['os']
  private readonly memoryDenials = new Set<string>()
  private readonly denialEpoch = new Map<string, number>()
  private reference: ProductCheckpoint
  constructor(private readonly options: ProductClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.os = options.os ?? (process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : 'other')
    const origin = new URL(options.apiOrigin)
    if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1','localhost','::1'].includes(origin.hostname))) throw new Error('invalid_product_analytics_origin')
    if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(options.appVersion)) throw new Error('invalid_product_analytics_version')
  }
  private async actor() {
    const token = await this.options.token()
    const subject = token && subjectForToken(token)
    return token && subject ? { token, subject } : undefined
  }
  private async current(subject: string): Promise<string | undefined> {
    const actor = await this.actor()
    return actor?.subject === subject ? actor.token : undefined
  }
  private directory(subject: string) { if (!hex64.test(subject)) throw new Error('invalid_subject'); return join(this.options.root, 'product-analytics-v1', subject) }
  private async denialToken(subject: string): Promise<string | undefined> {
    try { return (await readFile(join(this.directory(subject), 'denied'), 'utf8')) || 'invalid' }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : 'inaccessible' }
  }
  private async pendingDenial(subject: string): Promise<boolean> {
    return this.memoryDenials.has(subject) || (await this.denialToken(subject)) !== undefined
  }
  private async markDenial(subject: string): Promise<void> {
    this.memoryDenials.add(subject)
    this.denialEpoch.set(subject, (this.denialEpoch.get(subject) ?? 0) + 1)
    const dir = this.directory(subject)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const release = await lock(dir, { stale: 10000, retries: { retries: 2, minTimeout: 20, maxTimeout: 80 } })
    try {
      const temporary = join(dir, `denied.${randomUUID()}.tmp`)
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(randomUUID()); await file.sync() } finally { await file.close() }
      try { await rename(temporary, join(dir, 'denied')) } finally { await unlink(temporary).catch(() => {}) }
    } finally { await release() }
  }
  private async cachedConsent(subject: string): Promise<ProductConsent | undefined> {
    if (await this.pendingDenial(subject)) return undefined
    try {
      const value: unknown = JSON.parse(await readFile(join(this.directory(subject), 'consent.json'), 'utf8'))
      return validConsent(value, subject) ? value : undefined
    } catch { return undefined }
  }
  private async cacheConsent(value: ProductConsent): Promise<void> {
    const dir = this.directory(value.subjectId)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const release = await lock(dir, { stale: 10000, retries: { retries: 2, minTimeout: 20, maxTimeout: 80 } })
    try {
      let previous: unknown
      try { previous = JSON.parse(await readFile(join(dir, 'consent.json'), 'utf8')) } catch { /* No prior cache. */ }
      if (validConsent(previous, value.subjectId) && (previous.revision > value.revision ||
        (previous.revision === value.revision && previous.decision === 'denied' && value.decision !== 'denied'))) return
      const temporary = join(dir, `consent.${randomUUID()}.tmp`)
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(value)); await file.sync() } finally { await file.close() }
      try { await rename(temporary, join(dir, 'consent.json')) } finally { await unlink(temporary).catch(() => {}) }
    } finally { await release() }
  }
  private async request(actor: { token: string; subject: string }, method: 'GET' | 'PUT', body?: unknown): Promise<ProductConsent> {
    if (!(await this.current(actor.subject))) throw new Error('identity_changed')
    const response = await this.fetch(this.options.apiOrigin.replace(/\/$/, '') + '/api/analytics/product-consent', {
      method, signal: AbortSignal.timeout(5000), headers: { Authorization: `Bearer ${actor.token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!response.ok || !(await this.current(actor.subject))) throw new Error('consent_unavailable')
    const result: unknown = await response.json()
    const value = (result as { data?: unknown })?.data
    if (!validConsent(value, actor.subject)) throw new Error('invalid_consent')
    this.rememberReference(value)
    return value
  }
  private rememberReference(value: unknown): void {
    const candidate = (value as { serverTime?: unknown; serverOrder?: unknown; serverProof?: unknown })?.serverTime
    const parsed = typeof candidate === 'string' ? Date.parse(candidate) : NaN
    const order = positiveOrder((value as { serverOrder?: unknown })?.serverOrder)
    const proof = (value as { serverProof?: unknown })?.serverProof
    if (!Number.isFinite(parsed) || order === undefined || typeof proof !== 'string' ||
      !/^v1\.[1-9][0-9]{0,18}\.[a-f0-9]{64}$/.test(proof) || proof.split('.')[1] !== String(order)) { this.reference = undefined; return }
    if (this.reference === undefined || order > this.reference.order) {
      this.reference = { order, serverTime: parsed, proof }
    }
  }
  /** Snapshot synchronously at the action boundary, before asynchronous work. */
  captureCheckpoint(): ProductCheckpoint { return this.reference }
  /** Obtain a server reference without requiring an account or enabling analytics. */
  async primeCheckpoint(): Promise<void> {
    const response = await this.fetch(this.options.apiOrigin.replace(/\/$/, '') + '/api/analytics/product-consent', {
      method: 'GET', signal: AbortSignal.timeout(5000),
      headers: { 'X-Verboo-Analytics-Scope': randomBytes(32).toString('hex') },
    })
    if (!response.ok) return
    const result: unknown = await response.json()
    this.rememberReference((result as { data?: unknown })?.data)
  }
  /** Read the current account preference. A pending local refusal is applied first. */
  async status(): Promise<ProductConsent | undefined> {
    const actor = await this.actor()
    if (!actor) return undefined
    let consent = await this.request(actor, 'GET')
    if (await this.pendingDenial(actor.subject)) {
      if (consent.decision !== 'denied') consent = await this.request(actor, 'PUT', { decision: 'denied', revision: consent.revision, policyVersion: 1 })
      if (consent.decision !== 'denied') throw new Error('refusal_unconfirmed')
      await this.discard(actor.subject)
    } else if (consent.decision === 'denied') {
      await this.discard(actor.subject)
    }
    await this.cacheConsent(consent).catch(() => {})
    return consent
  }
  /** Explicit user choice; refusal blocks this subject locally before network access. */
  async choose(decision: 'granted' | 'denied'): Promise<ProductConsent> {
    const actor = await this.actor()
    if (!actor) throw new Error('account_unavailable')
    if (decision === 'denied') { await this.markDenial(actor.subject); await this.discard(actor.subject) }
    const originalDenial = await this.denialToken(actor.subject)
    const originalEpoch = this.denialEpoch.get(actor.subject) ?? 0
    let previous = await this.request(actor, 'GET')
    if (decision === 'granted' && !previous.enabled) throw new Error('analytics_disabled')
    // An offline refusal must reach the server before a subsequent grant, so
    // a stale grant revision can never revive the old turn's queued events.
    if (decision === 'granted' && await this.pendingDenial(actor.subject) && previous.decision !== 'denied') {
      previous = await this.request(actor, 'PUT', { decision: 'denied', revision: previous.revision, policyVersion: 1 })
      if (previous.decision !== 'denied') throw new Error('refusal_unconfirmed')
    }
    const result = await this.request(actor, 'PUT', { decision, revision: previous.revision, policyVersion: 1 })
    if (result.decision !== decision) throw new Error('choice_unconfirmed')
    await this.cacheConsent(result).catch(() => {})
    if (decision === 'granted') {
      const dir = this.directory(actor.subject)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const release = await lock(dir, { stale: 10000, retries: { retries: 2, minTimeout: 20, maxTimeout: 80 } })
      try {
        if ((this.denialEpoch.get(actor.subject) ?? 0) !== originalEpoch || await this.denialToken(actor.subject) !== originalDenial) throw new Error('choice_unconfirmed')
        if (originalDenial !== undefined) await unlink(join(dir, 'denied'))
        this.memoryDenials.delete(actor.subject)
      } finally { await release() }
    }
    return result
  }
  /** Snapshot before a human turn starts; an unavailable collector never implies consent. */
  async beginTurn(localOperation: string, startedAt = this.now(), expectedAccountId?: string, checkpoint?: ProductCheckpoint): Promise<ProductTurn | undefined> {
    if (checkpoint === undefined || !Number.isFinite(checkpoint.serverTime)) return undefined
    const actor = await this.actor()
    if (!actor || (expectedAccountId && (!uuid.test(expectedAccountId) || actor.subject !== sha('user:' + expectedAccountId.toLowerCase())))) return undefined
    let consent: ProductConsent | undefined
    try { consent = await this.status() } catch { consent = await this.cachedConsent(actor.subject) }
    if (!(await this.current(actor.subject)) || consent?.subjectId !== actor.subject) return undefined
    const decisionOrder = positiveOrder(consent.decisionOrder)
    if (!consent.enabled || consent.decision !== 'granted' || decisionOrder === undefined || decisionOrder >= checkpoint.order ||
      Date.parse(consent.expiresAt) <= startedAt || Date.parse(consent.decidedAt) > startedAt ||
      Date.parse(consent.expiresAt) <= checkpoint.serverTime) return undefined
    return { subjectId: consent.subjectId, consent, startedAt, operationId: operationId(actor.subject + ':' + localOperation), consentProof: checkpoint.proof }
  }
  /** Queue only a completed, nonempty main-agent response; no text enters this API. */
  async completeTurn(turn: ProductTurn, modality: ResponseEvent['modality'], occurredAt = this.now()): Promise<void> {
    if (!hex64.test(turn.subjectId) || !(await this.current(turn.subjectId)) || await this.pendingDenial(turn.subjectId)) return
    const now = this.now()
    if (!turn.consent.enabled || turn.consent.decision !== 'granted' || turn.consent.subjectId !== turn.subjectId ||
      now >= Date.parse(turn.consent.expiresAt) || occurredAt < turn.startedAt || occurredAt > now + 300000 ||
      turn.startedAt < Date.parse(turn.consent.decidedAt)) return
    const event: ResponseEvent = { schemaVersion: 1, eventId: turn.operationId, name: 'product_response_completed', consentRevision: turn.consent.revision, consentProof: turn.consentProof,
      occurredAt: new Date(occurredAt).toISOString(), surface: 'cli', os: this.os, appVersion: this.options.appVersion, operationId: turn.operationId,
      modality, outcome: 'completed', durationMs: Math.min(604800000, Math.max(0, Math.trunc(occurredAt - turn.startedAt))) }
    await this.enqueue(turn.subjectId, event)
  }
  /** Observe an authenticated interactive opening only if consent was valid at that instant. */
  async observeOpen(occurredAt: number, expectedAccountId: string, checkpoint: ProductCheckpoint): Promise<void> {
    const turn = await this.beginTurn(randomUUID(), occurredAt, expectedAccountId, checkpoint)
    if (!turn || !(await this.current(turn.subjectId)) || await this.pendingDenial(turn.subjectId)) return
    if (this.now() >= Date.parse(turn.consent.expiresAt) || occurredAt > this.now() + 300000) return
    await this.enqueueLifecycle(turn, 'product_opened', occurredAt)
    await this.enqueueLifecycle(turn, 'product_first_open_observed', occurredAt)
  }
  /** Observe a completed OAuth login only for its initiating account and an existing grant. */
  async observeLogin(occurredAt: number, expectedAccountId: string, checkpoint: ProductCheckpoint): Promise<void> {
    const turn = await this.beginTurn(randomUUID(), occurredAt, expectedAccountId, checkpoint)
    if (!turn || !(await this.current(turn.subjectId)) || await this.pendingDenial(turn.subjectId)) return
    if (this.now() >= Date.parse(turn.consent.expiresAt) || occurredAt > this.now() + 300000) return
    await this.enqueueLifecycle(turn, 'product_login_completed', occurredAt)
  }
  private async enqueueLifecycle(turn: ProductTurn, name: LifecycleEvent['name'], occurredAt: number): Promise<void> {
    const event: LifecycleEvent = { schemaVersion: 1, eventId: randomUUID(), name, consentRevision: turn.consent.revision, consentProof: turn.consentProof,
      occurredAt: new Date(occurredAt).toISOString(), surface: 'cli', os: this.os, appVersion: this.options.appVersion }
    await this.enqueue(turn.subjectId, event)
  }
  private async enqueue(subject: string, event: Queued): Promise<void> {
    if (!validEvent(event)) throw new Error('invalid_product_event')
    const dir = this.directory(subject)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const release = await lock(dir, { stale: 10000, retries: { retries: 2, minTimeout: 20, maxTimeout: 80 } })
    try {
      if (await this.pendingDenial(subject) || !(await this.current(subject))) return
      const firstOpen = event.name === 'product_first_open_observed'
      const marker = join(dir, 'first-open')
      if (firstOpen) {
        try {
          const existing = await readFile(marker, 'utf8')
          if (uuid.test(existing)) return
          await unlink(marker)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        // A crash may have left a queued first-open before its marker existed.
        // Recover that exact event before writing the marker; delivery ignores
        // first-open items until the matching marker exists.
        for (const name of await readdir(dir)) {
          if (!name.endsWith('.json') || !uuid.test(name.slice(0, -5))) continue
          const raw = await readFile(join(dir, name), 'utf8').catch(() => '')
          if (raw.length > 4096) continue
          let candidate: unknown
          try { candidate = JSON.parse(raw) } catch { continue }
          if (!validEvent(candidate) || candidate.name !== 'product_first_open_observed' || candidate.eventId !== name.slice(0, -5)) continue
          if (candidate.consentRevision !== event.consentRevision) { await unlink(join(dir, name)).catch(() => {}); continue }
          event = candidate
          break
        }
      }
      const target = join(dir, event.eventId + '.json')
      const names = await readdir(dir)
      if (!names.includes(event.eventId + '.json') && names.filter(name => name.endsWith('.json') && uuid.test(name.slice(0, -5))).length >= 1000) throw new Error('product_queue_full')
      const temporary = join(dir, `${event.eventId}.${randomUUID()}.tmp`)
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(event)); await file.sync() } finally { await file.close() }
      try { await link(temporary, target) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      } finally { await unlink(temporary).catch(() => {}) }
      if (firstOpen) {
        const file = await open(marker, 'wx', 0o600)
        try { await file.writeFile(event.eventId); await file.sync() } finally { await file.close() }
      }
    } finally { await release() }
    void this.flush().catch(() => {})
  }
  private async discard(subject: string): Promise<void> {
    const dir = this.directory(subject)
    const names = await readdir(dir).catch(() => [] as string[])
    await Promise.all(names.filter(name => name.endsWith('.json') && uuid.test(name.slice(0, -5))).map(name => unlink(join(dir, name)).catch(() => {})))
  }
  /** Retry original bytes only under the same confirmed subject and revision. */
  async flush(): Promise<void> {
    const actor = await this.actor()
    if (!actor || await this.pendingDenial(actor.subject)) return
    const consent = await this.status()
    if (!consent?.enabled || consent.subjectId !== actor.subject || consent.decision !== 'granted' || Date.parse(consent.expiresAt) <= this.now()) return
    const dir = this.directory(actor.subject)
    const names = await readdir(dir).catch(() => [] as string[])
    for (const name of names.filter(name => name.endsWith('.json') && uuid.test(name.slice(0, -5))).slice(0, 12)) {
      if (!(await this.current(actor.subject)) || await this.pendingDenial(actor.subject)) return
      const raw = await readFile(join(dir, name), 'utf8').catch(() => '')
      if (raw.length > 4096) continue
      let value: unknown
      try { value = JSON.parse(raw) } catch { continue }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const legacy = value as { schemaVersion?: unknown; eventId?: unknown; name?: unknown; surface?: unknown; consentProof?: unknown }
        if (legacy.schemaVersion === 1 && legacy.eventId === name.slice(0, -5) && legacy.surface === 'cli' &&
          ['product_opened', 'product_first_open_observed', 'product_login_completed', 'product_response_completed'].includes(String(legacy.name)) &&
          !Object.hasOwn(legacy, 'consentProof')) {
          const release = await lock(dir, { stale: 10000, retries: { retries: 2, minTimeout: 20, maxTimeout: 80 } })
          try {
            if (await readFile(join(dir, name), 'utf8').catch(() => '') === raw) {
              if (legacy.name === 'product_first_open_observed' && await readFile(join(dir, 'first-open'), 'utf8').catch(() => '') === legacy.eventId) {
                await unlink(join(dir, 'first-open')).catch(() => {})
              }
              await unlink(join(dir, name)).catch(() => {})
            }
          } finally { await release() }
          continue
        }
      }
      if (!validEvent(value) || value.eventId !== name.slice(0, -5)) continue
      if (value.name === 'product_first_open_observed' && await readFile(join(dir, 'first-open'), 'utf8').catch(() => '') !== value.eventId) continue
      if (value.consentRevision !== consent.revision) { await unlink(join(dir, name)).catch(() => {}); continue }
      try {
        const token = await this.current(actor.subject)
        if (!token) return
        const response = await this.fetch(this.options.apiOrigin.replace(/\/$/, '') + '/api/analytics/product-events', { method: 'POST',
          signal: AbortSignal.timeout(8000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: raw })
        if (response.status !== 202 || !(await this.current(actor.subject))) continue
        const receipt = (await response.json() as { data?: { status?: string; receipt?: { eventId?: string; payloadSha256?: string } } }).data
        if (receipt?.status === 'accepted' && receipt.receipt?.eventId === value.eventId && receipt.receipt.payloadSha256 === sha(raw)) {
          // Removal must still match the bytes acknowledged by the receiver.
          if (await readFile(join(dir, name), 'utf8').catch(() => '') === raw) await unlink(join(dir, name)).catch(() => {})
        }
      } catch { /* Original bytes stay queued for a later retry. */ }
    }
  }
}
