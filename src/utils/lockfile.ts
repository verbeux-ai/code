/**
 * Lazy accessor for proper-lockfile.
 *
 * proper-lockfile depends on graceful-fs, which monkey-patches every fs
 * method on first require (~8ms). Static imports of proper-lockfile pull this
 * cost into the startup path even when no locking happens (e.g. `--help`).
 *
 * Import this module instead of `proper-lockfile` directly. The underlying
 * package is only loaded the first time a lock function is actually called.
 */

import type { CheckOptions, LockOptions, UnlockOptions } from 'proper-lockfile'

type Lockfile = typeof import('proper-lockfile')

let _lockfile: Lockfile | undefined

function getLockfile(): Lockfile {
  if (!_lockfile) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _lockfile = require('proper-lockfile') as Lockfile
  }
  return _lockfile
}

// R3 guard: proper-lockfile@4.1.2 schedules a heartbeat fs.stat on lock().
// The heartbeat's stat callback re-enters updateLock and reads
// `lock.updateTimeout` on `locks[file]`. If the user releases the lock
// first, `locks[file]` is undefined and the next stat callback (Windows
// EACCES/EPERM is the field candidate) crashes the process with TypeError
// at lib/lockfile.js:104. We intercept the user-supplied `options.fs`
// stat/utimes so that any callback landing after release() is rewritten
// to ENOENT, which steers proper-lockfile into the ECOMPROMISED branch
// (handled by the no-op onCompromised we install below) instead of the
// recursive updateLock path.
type UserFs = NonNullable<LockOptions['fs']>
type StatFn = UserFs['stat']
type UtimesFn = UserFs['utimes']

interface ReleaseGuard {
  released: boolean
}

function installReleaseGuard(fs: UserFs, guard: ReleaseGuard): void {
  const originalStat = fs.stat.bind(fs) as StatFn
  const originalUtimes = fs.utimes.bind(fs) as UtimesFn
  ;(fs as { stat: StatFn }).stat = ((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: NodeJS.ErrnoException | null, stat?: unknown) => void
    const callArgs = args.slice(0, -1) as Parameters<StatFn>
    originalStat(...callArgs, ((err: NodeJS.ErrnoException | null, stat?: unknown) => {
      if (guard.released && err && err.code !== 'ENOENT') {
        // Rewrite post-release EACCES/EPERM (and any non-ENOENT) to ENOENT
        // so proper-lockfile takes the compromised branch and exits the
        // heartbeat, instead of recursing into updateLock with a removed
        // lock.
        return cb(Object.assign(new Error('ENOENT (post-release guard)'), { code: 'ENOENT' }))
      }
      cb(err, stat)
    }) as Parameters<StatFn>[1])
  }) as StatFn
  ;(fs as { utimes: UtimesFn }).utimes = ((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: NodeJS.ErrnoException | null) => void
    const callArgs = args.slice(0, -1) as Parameters<UtimesFn>
    originalUtimes(...callArgs, ((err: NodeJS.ErrnoException | null) => {
      if (guard.released && err && err.code !== 'ENOENT') {
        return cb(Object.assign(new Error('ENOENT (post-release guard)'), { code: 'ENOENT' }))
      }
      cb(err)
    }) as Parameters<UtimesFn>[3])
  }) as UtimesFn
}

export function lock(
  file: string,
  options?: LockOptions,
): Promise<() => Promise<void>> {
  const userOptions = options ?? {}
  // Default graceful-fs has no settable stat/utimes we can monkey-patch
  // for the default path (we don't want to). Only install the guard when
  // the caller supplied a custom fs, which is the test seam for R3 and
  // any production caller wrapping fs. Otherwise rely on proper-lockfile's
  // own unlock clearTimeout, which handles the normal path.
  const guard: ReleaseGuard = { released: false }
  const merged: LockOptions = userOptions.fs
    ? (() => {
        installReleaseGuard(userOptions.fs as UserFs, guard)
        return { ...userOptions, onCompromised: () => {} }
      })()
    : userOptions
  return getLockfile().lock(file, merged).then((release) => {
    let released = false
    return async () => {
      if (released) return
      released = true
      guard.released = true
      try {
        await release()
      } catch (err) {
        // ERELEASED on a second release is benign — the caller already
        // released through this guard.
        if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ERELEASED') {
          return
        }
        throw err
      }
    }
  })
}

export function lockSync(file: string, options?: LockOptions): () => void {
  return getLockfile().lockSync(file, options)
}

export function unlock(file: string, options?: UnlockOptions): Promise<void> {
  return getLockfile().unlock(file, options)
}

export function check(file: string, options?: CheckOptions): Promise<boolean> {
  return getLockfile().check(file, options)
}
