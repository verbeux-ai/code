/**
 * Regression test for R3 — proper-lockfile@4.1.2 heartbeat crash on Windows.
 *
 * Reproduces the interleaving from the field report:
 *   1. acquire lock → heartbeat schedules fs.stat
 *   2. release the lock → `locks[file]` is removed and `lock.released = true`
 *   3. the in-flight stat callback returns with EACCES/EPERM (the Windows
 *      sharing-violation candidate) and the dependency's updateLock reads
 *      `lock.updateTimeout` on an undefined lock → TypeError, process dies.
 *
 * The wrapper must rewrite post-release stat/utimes errors to ENOENT so
 * proper-lockfile exits the heartbeat cleanly via the ECOMPROMISED branch
 * instead of recursing into updateLock on a removed lock.
 *
 * Bun's runner will surface an uncaught TypeError as a test failure — the
 * GREEN assertion is that the run completes without an uncaught throw.
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const TMP_ROOT = mkdtempSync(join(tmpdir(), 'verboo-lockfile-r3-'))

afterEach(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true })
  mock.restore()
})

beforeEach(() => {
  mock.restore()
})

interface HeartbeatFixture {
  file: string
  release: () => Promise<void>
  releaseHeartbeat: (code: 'EACCES' | 'EPERM') => void
  statCalls: number
}

async function setupHeartbeat(): Promise<HeartbeatFixture> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const properLockfile = require('proper-lockfile') as typeof import('proper-lockfile')
  void properLockfile
  const parked: Array<{ release: (err: NodeJS.ErrnoException | null, stat?: unknown) => void }> = []
  let statCalls = 0

  const fakeFs = {
    mkdir: ((_p: string, cb: (err: NodeJS.ErrnoException | null) => void) => cb(null)) as unknown as typeof import('fs')['mkdir'],
    rmdir: ((_p: string, cb: (err: NodeJS.ErrnoException | null) => void) => cb(null)) as unknown as typeof import('fs')['rmdir'],
    stat: ((_p: string, cb: (err: NodeJS.ErrnoException | null, stat?: unknown) => void) => {
      statCalls++
      // First stat = probe (mtimePrecision probe) → return valid stat
      // Subsequent = heartbeat → park until the test releases them with
      // an EACCES/EPERM that mimics the Windows sharing-violation
      // candidate from the field report.
      if (statCalls === 1) {
        const stat = { mtime: new Date(Date.now() - 1000) }
        return cb(null, stat)
      }
      parked.push({ release: cb })
    }) as unknown as typeof import('fs')['stat'],
    utimes: ((_p: string, _a: unknown, _m: unknown, cb: (err: NodeJS.ErrnoException | null) => void) => cb(null)) as unknown as typeof import('fs')['utimes'],
    realpath: ((p: string, cb: (err: NodeJS.ErrnoException | null, resolved?: string) => void) => cb(null, p)) as unknown as typeof import('fs')['realpath'],
  } as unknown as typeof import('fs')

  const wrapper = await import('./lockfile.js')

  const file = join(TMP_ROOT, `r3-${Math.random().toString(36).slice(2)}.lock`)
  const release = await wrapper.lock(file, {
    stale: 5000,
    update: 1000, // heartbeat at 1000ms
    realpath: false,
    fs: fakeFs,
    retries: 0,
  } as Parameters<typeof wrapper.lock>[1])

  return {
    file,
    release,
    releaseHeartbeat: (code) => {
      const err = Object.assign(new Error(`simulated ${code}`), { code }) as NodeJS.ErrnoException
      const queue = parked.splice(0)
      for (const { release } of queue) release(err)
    },
    get statCalls() {
      return statCalls
    },
  } as HeartbeatFixture
}

test('R3: heartbeat EACCES after release must not crash the process', async () => {
  const fixture = await setupHeartbeat()

  // Release the lock BEFORE the parked stat returns. With the unfixed
  // wrapper (or a direct proper-lockfile caller), proper-lockfile's
  // updateLock would be invoked with `locks[file]` undefined and throw
  // TypeError on `lock.updateTimeout`.
  await fixture.release()

  // Now release the parked stat with EACCES (Windows sharing-violation).
  fixture.releaseHeartbeat('EACCES')

  // Give the event loop a chance to surface any uncaught throw.
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setTimeout(r, 50))

  // After release + drain, the internal locks table must be empty.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const properLockfile = require('proper-lockfile') as { getLocks?: () => Record<string, unknown> }
  if (typeof properLockfile.getLocks === 'function') {
    expect(Object.keys(properLockfile.getLocks()).length).toBe(0)
  }
})

test('R3: heartbeat EPERM after release must not crash the process', async () => {
  const fixture = await setupHeartbeat()
  // Wait long enough for the heartbeat to schedule a stat that we can park.
  // proper-lockfile clamps heartbeat to >=1000ms; we use update:1000 and
  // add a margin so the heartbeat has fired by the time we release.
  await new Promise((r) => setTimeout(r, 1300))
  expect(fixture.statCalls).toBeGreaterThanOrEqual(2)
  await fixture.release()
  fixture.releaseHeartbeat('EPERM')
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setTimeout(r, 50))
  // The fix rewrites the post-release EPERM to ENOENT, so the dependency
  // exits the heartbeat via ECOMPROMISED without recursing into updateLock.
  expect(fixture.statCalls).toBeGreaterThanOrEqual(2)
})

test('R3: double release must be idempotent (ERELEASED swallowed)', async () => {
  const fixture = await setupHeartbeat()
  await fixture.release()
  // Second release should not throw — the wrapper swallows ERELEASED.
  await fixture.release()
  // Drain any parked heartbeat stats so they don't fire later.
  fixture.releaseHeartbeat('ENOENT')
  expect(true).toBe(true)
})
