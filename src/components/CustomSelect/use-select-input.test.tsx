import { PassThrough } from 'node:stream'

import { expect, test } from 'bun:test'
import React from 'react'

import { createRoot } from '../../ink.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../../state/AppState.js'
import { Select } from './select.js'

function createTestStreams(): {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
} {
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
  return { stdout, stdin }
}

async function selectWithKeys(
  wrapped: boolean,
  keys: string[],
): Promise<string | null> {
  const { stdout, stdin } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  let selected: string | null = null
  const select = (
    <Select
      options={[
        { label: 'Primeiro', value: 'first' },
        { label: 'Segundo', value: 'second' },
      ]}
      onChange={(value: string) => {
        selected = value
      }}
    />
  )
  root.render(
    wrapped ? (
      <AppStateProvider>
        <KeybindingSetup>{select}</KeybindingSetup>
      </AppStateProvider>
    ) : (
      select
    ),
  )

  try {
    await Bun.sleep(20)
    for (const key of keys) {
      stdin.write(key)
      await Bun.sleep(20)
    }
    return selected
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await Bun.sleep(0)
  }
}

test('standalone Select supports down arrow and Enter', async () => {
  await expect(selectWithKeys(false, ['\x1B[B', '\r'])).resolves.toBe('second')
})

test('Select keeps configured keybindings when a provider is present', async () => {
  await expect(selectWithKeys(true, ['\x1B[B', '\r'])).resolves.toBe('second')
})
