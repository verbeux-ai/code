import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('provider-account storage locking', () => {
  test('serializes two real CLI processes so neither account update is lost', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verboo-provider-lock-'))
    roots.push(root)
    await mkdir(root, { recursive: true })
    const statePath = join(root, 'state.json')
    await writeFile(statePath, '[]')

    const helperPath = join(import.meta.dir, '../secureStorageMutationLock.ts')
    const script = `
      import { readFileSync, writeFileSync } from 'node:fs'
      import { withSecureStorageMutationLock } from ${JSON.stringify(helperPath)}
      withSecureStorageMutationLock(() => {
        const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf8'))
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75)
        state.push(process.argv.at(-1))
        writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state))
      })
    `
    const env = { ...process.env, VERBOO_CONFIG_DIR: root }
    const first = Bun.spawn([process.execPath, '-e', script, 'account-a'], { env })
    const second = Bun.spawn([process.execPath, '-e', script, 'account-b'], { env })
    const [firstExit, secondExit] = await Promise.all([first.exited, second.exited])

    expect(firstExit).toBe(0)
    expect(secondExit).toBe(0)
    expect(JSON.parse(await readFile(statePath, 'utf8')).sort()).toEqual(['account-a', 'account-b'])
  })
})
