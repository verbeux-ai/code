import { PassThrough } from 'node:stream'

import { expect, mock, test } from 'bun:test'
import React from 'react'

import { createRoot, Text } from '../ink.js'
import { CLAUDE_RISK_NOTICE_VERSION } from '../services/api/claudeNativeConfig.js'

function createTestStreams() {
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

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 5_000) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error('Timed out waiting for Claude OAuth hook test condition')
}

const TOKENS = {
  accessToken: 'claude-access-token',
  refreshToken: 'claude-refresh-token',
  expiresAt: 2_000_000_000_000,
  scopes: ['user:profile', 'user:inference'],
  accountId: 'claude-account-1',
  email: 'user@example.com',
}

test('persists versioned risk acceptance only after downstream validation succeeds', async () => {
  const saveCredentials = mock(() => ({ success: true }))
  const cleanup = mock(() => {})
  const onAuthenticated = mock(
    async (
      _tokens: typeof TOKENS,
      persistCredentials: () => void,
    ) => persistCredentials(),
  )
  const deps = {
    createOAuthService: () => ({
      async startOAuthFlow(
        onAuthorizationUrl: (url: string) => void | Promise<void>,
      ) {
        await onAuthorizationUrl('https://claude.com/cai/oauth/authorize')
        return TOKENS
      },
      cleanup,
    }),
    openBrowser: async () => true,
    saveCredentials,
    isBareMode: () => false,
  }
  const { useClaudeNativeOAuthFlow } = await import(
    `./useClaudeNativeOAuthFlow.js?persist-${Date.now()}-${Math.random()}`
  )

  function Harness(): React.ReactNode {
    const handler = React.useCallback(onAuthenticated, [])
    const status = useClaudeNativeOAuthFlow({
      acceptedAt: '2026-08-06T00:00:00.000Z',
      onAuthenticated: handler,
      deps,
    })
    return <Text>{status.state}</Text>
  }

  const streams = createTestStreams()
  const root = await createRoot({
    stdout: streams.stdout as unknown as NodeJS.WriteStream,
    stdin: streams.stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  root.render(<Harness />)
  try {
    await waitFor(() => saveCredentials.mock.calls.length === 1)
    expect(saveCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: TOKENS.accountId,
        riskAcceptance: {
          version: CLAUDE_RISK_NOTICE_VERSION,
          acceptedAt: '2026-08-06T00:00:00.000Z',
          accountId: TOKENS.accountId,
        },
      }),
    )
  } finally {
    root.unmount()
    streams.stdin.end()
    streams.stdout.end()
    await Bun.sleep(0)
  }
})

test('cancel stops OAuth and ignores a late completion', async () => {
  const cleanup = mock(() => {})
  const saveCredentials = mock(() => ({ success: true }))
  const onAuthenticated = mock(async () => {})
  let resolveOAuth: ((tokens: typeof TOKENS) => void) | undefined
  let cancel: (() => void) | undefined
  const deps = {
    createOAuthService: () => ({
      async startOAuthFlow(
        onAuthorizationUrl: (url: string) => void | Promise<void>,
      ) {
        await onAuthorizationUrl('https://claude.com/cai/oauth/authorize')
        return new Promise<typeof TOKENS>(resolve => {
          resolveOAuth = resolve
        })
      },
      cleanup,
    }),
    openBrowser: async () => true,
    saveCredentials,
    isBareMode: () => false,
  }
  const { useClaudeNativeOAuthFlow } = await import(
    `./useClaudeNativeOAuthFlow.js?cancel-${Date.now()}-${Math.random()}`
  )

  function Harness(): React.ReactNode {
    const handler = React.useCallback(onAuthenticated, [])
    const status = useClaudeNativeOAuthFlow({
      acceptedAt: '2026-08-06T00:00:00.000Z',
      onAuthenticated: handler,
      deps,
    })
    cancel = status.cancel
    return <Text>{status.state}</Text>
  }

  const streams = createTestStreams()
  const root = await createRoot({
    stdout: streams.stdout as unknown as NodeJS.WriteStream,
    stdin: streams.stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  root.render(<Harness />)
  try {
    await waitFor(() => Boolean(resolveOAuth && cancel))
    cancel?.()
    expect(cleanup).toHaveBeenCalledTimes(1)
    resolveOAuth?.(TOKENS)
    await Bun.sleep(0)
    await Bun.sleep(0)
    expect(onAuthenticated).not.toHaveBeenCalled()
    expect(saveCredentials).not.toHaveBeenCalled()
  } finally {
    root.unmount()
    streams.stdin.end()
    streams.stdout.end()
    await Bun.sleep(0)
  }
  expect(cleanup).toHaveBeenCalledTimes(1)
})

test('persists an additive Claude login against the requested local account id', async () => {
  const saveCredentials = mock(() => ({ success: true }))
  const cleanup = mock(() => {})
  const onAuthenticated = mock(
    async (
      _tokens: typeof TOKENS,
      persistCredentials: (options?: { reconnectLocalAccountId?: string }) => void,
      _candidate: unknown,
    ) => persistCredentials({ reconnectLocalAccountId: 'local-claude-2' }),
  )
  const deps = {
    createOAuthService: () => ({
      async startOAuthFlow(
        onAuthorizationUrl: (url: string) => void | Promise<void>,
      ) {
        await onAuthorizationUrl('https://claude.com/cai/oauth/authorize')
        return TOKENS
      },
      cleanup,
    }),
    openBrowser: async () => true,
    saveCredentials,
    isBareMode: () => false,
  }
  const { useClaudeNativeOAuthFlow } = await import(
    `./useClaudeNativeOAuthFlow.js?additive-${Date.now()}-${Math.random()}`
  )

  function Harness(): React.ReactNode {
    const handler = React.useCallback(onAuthenticated, [onAuthenticated])
    useClaudeNativeOAuthFlow({
      additive: true,
      reconnectLocalAccountId: 'local-claude-2',
      acceptedAt: '2026-08-06T00:00:00.000Z',
      onAuthenticated: handler,
      deps,
    })
    return <Text>waiting</Text>
  }

  const streams = createTestStreams()
  const root = await createRoot({
    stdout: streams.stdout as unknown as NodeJS.WriteStream,
    stdin: streams.stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  root.render(<Harness />)
  try {
    await waitFor(() => saveCredentials.mock.calls.length === 1)
    expect(saveCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: TOKENS.accountId }),
      { localAccountId: 'local-claude-2', additive: true },
    )
  } finally {
    root.unmount()
    streams.stdin.end()
    streams.stdout.end()
    await Bun.sleep(0)
  }
})
