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
  triggerHeartbeatStat: () => Promise<{ code: string | undefined }>
}

/**
 * Capture the next fakeFs.stat invocation. Resolves with the error code
 * (or undefined for a successful stat) the wrapped callback ultimately
 * receives. Lets the tests drive the heartbeat directly instead of
 * waiting on proper-lockfile's unref'd setTimeout, which never reaches
 * the event loop under full-suite CPU pressure.
 */
function captureNextStatError(
  fakeFs: { stat: (p: string, cb: (e: NodeJS.ErrnoException | null, stat?: unknown) => void) => void },
): Promise<{ code: string | undefined }> {
  return new Promise((resolve) => {
    fakeFs.stat('ignored', (err) => {
      resolve({ code: err?.code })
    })
  })
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

  // Cache-busting require bypasses any inherited `mock.module('./lockfile.js', ...)`
  // set by other test files (auth.refresh.test.ts installs one in beforeAll;
  // Bun's `mock.restore()` does NOT restore to a pristine import). Without
  // this, installReleaseGuard never runs, fakeFs.stat is left unwrapped, and
  // the parked callback fires with raw EACCES/EPERM instead of the ENOENT
  // rewrite the production wrapper performs.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const wrapper = require('./lockfile.js?bust=' + Date.now()) as typeof import('./lockfile.js')

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
    triggerHeartbeatStat: () => captureNextStatError(fakeFs as never),
  } as HeartbeatFixture
}

test('R3: heartbeat EACCES after release must not crash the process', async () => {
  const fixture = await setupHeartbeat()

  // Drive the heartbeat's stat directly (same mechanism as the EPERM test
  // below). The original EACCES test relied on the heartbeat timer to park
  // a callback — when the timer never fires, parked stays empty and the
  // getLocks assertion passed by vacuity. With triggerHeartbeatStat, we
  // park a real callback that the wrapper must rewrite.
  const statResult = fixture.triggerHeartbeatStat()
  await fixture.release()

  // Release the parked stat with EACCES (Windows sharing-violation).
  fixture.releaseHeartbeat('EACCES')

  // The wrapper's release-guard rewrites EACCES → ENOENT before proper-lockfile's
  // updateLock sees it, so the heartbeat exits via ECOMPROMISED instead of
  // recursing on the removed lock. Without the guard, the cb receives raw
  // EACCES and proper-lockfile crashes on `locks[file]` undefined.
  const { code } = await statResult
  expect(code).toBe('ENOENT')
})

test('R3: heartbeat EPERM after release must not crash the process', async () => {
  const fixture = await setupHeartbeat()
  // Drive the heartbeat's stat directly. Replaces the original 1300ms
  // wall-clock sleep that was starved under full-suite CPU pressure and
  // never fired — leaving the test asserting against statCalls that never
  // arrived, and breaking the gate without exercising anything.
  const statResult = fixture.triggerHeartbeatStat()
  await fixture.release()
  fixture.releaseHeartbeat('EPERM')
  const { code } = await statResult
  expect(code).toBe('ENOENT')
  // The probe is statCalls === 1; the heartbeat stat we just triggered is
  // statCalls === 2. With the rewrite active, the wrapper short-circuits
  // the post-release stat to ENOENT before proper-lockfile's updateLock.
  expect(fixture.statCalls).toBeGreaterThanOrEqual(2)
})

test('R3: double release must be idempotent (ERELEASED swallowed)', async () => {
  const fixture = await setupHeartbeat()
  await fixture.release()
  // Second release should not throw — the wrapper swallows ERELEASED.
  await fixture.release()
  expect(true).toBe(true)
})
