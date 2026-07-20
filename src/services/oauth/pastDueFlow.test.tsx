import { PassThrough } from 'node:stream'

import { afterEach, expect, mock, test } from 'bun:test'
import axios from 'axios'
import React from 'react'
import stripAnsi from 'strip-ansi'

import { render } from '../../ink.js'
import { PastDueView, showPastDueNotice } from './pastDueFlow.js'

const originalGet = axios.get

const pastDueSubscription = {
  id: '11111111-1111-4111-8111-111111111111',
  groupId: '22222222-2222-4222-8222-222222222222',
  status: 'past_due',
  group: {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Plano pendente',
    slug: 'plano-pendente',
    priceCents: 1_000,
    currency: 'brl',
    billingInterval: 'month',
    status: 'active',
  },
  cancelAtPeriodEnd: false,
}

const activeSubscription = {
  id: '33333333-3333-4333-8333-333333333333',
  groupId: '44444444-4444-4444-8444-444444444444',
  status: 'active',
  currentPeriodEnd: '2030-01-01T00:00:00Z',
  cancelAtPeriodEnd: false,
}

afterEach(() => {
  axios.get = originalGet
})

test('shows an interactive warning without a selector and continues automatically', async () => {
  axios.get = mock(async () => ({
    data: { data: [pastDueSubscription, activeSubscription] },
  })) as typeof axios.get

  let output = ''
  let completed = false
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  stdout.on('data', (chunk) => {
    output += chunk.toString()
  })

  const instance = await render(
    <PastDueView accessToken="access-token" onDone={() => { completed = true }} />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    },
  )

  try {
    const startedAt = Date.now()
    while (Date.now() - startedAt < 1_500 && !completed) {
      await Bun.sleep(20)
    }
    const rendered = stripAnsi(output)
    expect(completed).toBe(true)
    expect(rendered).toContain('Pagamento pendente em Plano pendente')
    expect(rendered).toContain('Seu acesso pelos outros planos ativos continua liberado')
    expect(rendered).not.toContain('Regularizar agora')
    expect(rendered).not.toContain('Sair sem comprar outro plano')
  } finally {
    instance.unmount()
    stdin.end()
    stdout.end()
  }
})

test('is silent and continues headlessly when another subscription grants access', async () => {
  axios.get = mock(async () => ({
    data: { data: [pastDueSubscription, activeSubscription] },
  })) as typeof axios.get

  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  const originalWrite = process.stdout.write
  const writes: string[] = []
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false })
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
  process.stdout.write = ((chunk: unknown) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stdout.write

  try {
    await expect(showPastDueNotice('access-token')).resolves.toBe(true)
    expect(writes).toEqual([])
  } finally {
    process.stdout.write = originalWrite
    if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY)
    else delete (process.stdin as { isTTY?: boolean }).isTTY
    if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY)
    else delete (process.stdout as { isTTY?: boolean }).isTTY
  }
})

test('stays blocked headlessly when every subscription is past due', async () => {
  axios.get = mock(async () => ({
    data: { data: [pastDueSubscription] },
  })) as typeof axios.get

  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  const originalWrite = process.stdout.write
  const writes: string[] = []
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false })
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
  process.stdout.write = ((chunk: unknown) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stdout.write

  try {
    await expect(showPastDueNotice('access-token')).resolves.toBe(false)
    expect(writes).toEqual([])
  } finally {
    process.stdout.write = originalWrite
    if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY)
    else delete (process.stdin as { isTTY?: boolean }).isTTY
    if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY)
    else delete (process.stdout as { isTTY?: boolean }).isTTY
  }
})
