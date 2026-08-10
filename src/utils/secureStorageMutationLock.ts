import { join } from 'node:path'

import { getClaudeConfigHomeDir } from './envUtils.js'
import { getFsImplementation } from './fsOperations.js'
import { lockSync } from './lockfile.js'

/** Serialize read/modify/write operations against the shared native vault. */
export function withSecureStorageMutationLock<T>(work: () => T): T {
  const configDir = getClaudeConfigHomeDir()
  const lockPath = join(configDir, '.provider-accounts.lock')
  let release: (() => void) | undefined
  let compromised = false
  try {
    getFsImplementation().mkdirSync(configDir)
    for (let attempt = 0; attempt < 9; attempt += 1) {
      try {
        // proper-lockfile rejects `retries` for lockSync. Retry the sync API
        // explicitly so a second CLI process waits instead of failing every
        // mutation immediately.
        release = lockSync(configDir, {
          lockfilePath: lockPath,
          stale: 30_000,
          onCompromised: () => {
            // proper-lockfile's default callback throws from a heartbeat
            // timer, becoming an uncaught process-level exception. Record
            // the compromise and fail the guarded operation synchronously.
            compromised = true
          },
        })
        break
      } catch (error: unknown) {
        const code = error && typeof error === 'object' && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined
        if (code !== 'ELOCKED' || attempt === 8) throw error
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          Math.min(250, 25 * (attempt + 1)),
        )
      }
    }
    if (!release) throw new Error('provider_storage_lock_failed')
  } catch {
    throw new Error('provider_storage_lock_failed')
  }
  try {
    const result = work()
    if (compromised) throw new Error('provider_storage_lock_compromised')
    return result
  } finally {
    release?.()
  }
}
