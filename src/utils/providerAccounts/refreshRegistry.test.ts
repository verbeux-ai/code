import { expect, test } from 'bun:test'

import { AccountWorkRegistry } from './refreshRegistry.js'

test('account A and B never share the same in-flight result', async () => {
  const registry = new AccountWorkRegistry<string>()
  let releaseA!: (value: string) => void
  const a = registry.run(
    'codex:local-a',
    () => new Promise(resolve => { releaseA = resolve }),
  )
  const b = registry.run('codex:local-b', async () => 'token-b')
  const duplicateA = registry.run('codex:local-a', async () => 'wrong-token')
  releaseA('token-a')

  expect(await Promise.all([a, b, duplicateA])).toEqual([
    'token-a',
    'token-b',
    'token-a',
  ])
})

test('a rejected operation is removed so the next attempt can run', async () => {
  const registry = new AccountWorkRegistry<string>()
  await expect(registry.run('claude:local-a', async () => {
    throw new Error('first-failure')
  })).rejects.toThrow('first-failure')
  await expect(registry.run('claude:local-a', async () => 'recovered'))
    .resolves.toBe('recovered')
})
