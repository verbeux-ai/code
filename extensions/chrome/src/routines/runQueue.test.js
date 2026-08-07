import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createRunQueue } from './runQueue.js'

test('executes browser-control work one item at a time', async () => {
  const queue = createRunQueue()
  const order = []
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })

  const first = queue.enqueue({
    id: 'a',
    execute: async () => {
      order.push('a:start')
      await gate
      order.push('a:end')
    },
  })
  const second = queue.enqueue({
    id: 'b',
    execute: async () => {
      order.push('b')
    },
  })

  await Promise.resolve()
  assert.equal(queue.activeId(), 'a')
  assert.deepEqual(order, ['a:start'])
  release()
  await Promise.all([first, second])
  assert.deepEqual(order, ['a:start', 'a:end', 'b'])
  assert.equal(queue.activeId(), null)
})

test('cancels queued work without running it', async () => {
  const queue = createRunQueue()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const first = queue.enqueue({ id: 'a', execute: () => gate })
  const second = queue.enqueue({ id: 'b', execute: async () => 'never' })

  assert.equal(queue.cancel('b'), true)
  await assert.rejects(second, /run_cancelled/)
  release()
  await first
})

test('pauses active work through its cooperative pause callback', async () => {
  const queue = createRunQueue()
  let paused = false
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const run = queue.enqueue({
    id: 'pause-me',
    execute: async () => {
      await gate
      return 'queued'
    },
    pause: () => {
      paused = true
      release()
    },
  })

  assert.equal(queue.pause('pause-me'), true)
  await run
  assert.equal(paused, true)
})
