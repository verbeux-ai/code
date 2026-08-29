import { afterEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveRuntimeCodexCredentials } from './providerConfig.js'

afterEach(() => {
  mock.restore()
})

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }))
    .toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

test('runtime credential resolution prefers stored credentials over an explicit auth.json path', () => {
  // Spec update (issue #107): when the caller passes storedCredentials,
  // the explicit account selection wins over env credentials (including
  // CODEX_AUTH_JSON_PATH pointing at a valid auth.json file). The legacy
  // behaviour of returning source='auth.json' in this scenario has been
  // inverted — the stored credential is authoritative.
  const tempDir = mkdtempSync(join(tmpdir(), 'verboo-codex-explicit-auth-'))
  const authPath = join(tempDir, 'auth.json')

  writeFileSync(
    authPath,
    JSON.stringify({
      openai_api_key: makeJwt({
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'acct_explicit_auth_json',
        },
      }),
    }),
    'utf8',
  )

  try {
    const credentials = resolveRuntimeCodexCredentials({
      env: {
        CODEX_AUTH_JSON_PATH: authPath,
      } as NodeJS.ProcessEnv,
      storedCredentials: {
        apiKey: 'stored-api-key',
        accessToken: 'stored-access-token',
        accountId: 'acct_stored',
      },
    })

    expect(credentials.source).toBe('secure-storage')
    expect(credentials.accountId).toBe('acct_stored')
    expect(credentials.apiKey).toBe('stored-api-key')
  } finally {
    rmSync(tempDir, { force: true, recursive: true })
  }
})

test('runtime credential resolution prefers stored credentials over an explicit auth.json path (even when missing)', () => {
  // Spec update (issue #107): explicit account selection — caller passes
  // storedCredentials — must win over env credentials (CODEX_HOME /
  // CODEX_AUTH_JSON_PATH), even when the env path is missing. The legacy
  // behaviour of returning source='none' with the env path preserved has
  // been replaced: the stored credential is authoritative.
  const tempDir = mkdtempSync(join(tmpdir(), 'verboo-codex-missing-auth-'))
  const authPath = join(tempDir, 'missing-auth.json')

  try {
    const credentials = resolveRuntimeCodexCredentials({
      env: {
        CODEX_AUTH_JSON_PATH: authPath,
      } as NodeJS.ProcessEnv,
      storedCredentials: {
        apiKey: 'stored-api-key',
        accessToken: 'stored-access-token',
        accountId: 'acct_stored',
      },
    })

    expect(credentials.source).toBe('secure-storage')
    expect(credentials.accountId).toBe('acct_stored')
    expect(credentials.apiKey).toBe('stored-api-key')
  } finally {
    rmSync(tempDir, { force: true, recursive: true })
  }
})

test('runtime credential resolution avoids sync secure-storage reads when async credentials are provided', async () => {
  let syncReadCalled = false

  mock.module('../../utils/codexCredentials.js', () => ({
    isCodexRefreshFailureCoolingDown: () => false,
    readCodexCredentials: () => {
      syncReadCalled = true
      throw new Error('sync secure-storage read should not run in runtime resolution')
    },
  }))

  // @ts-expect-error cache-busting query string for Bun module mocks
  const { resolveRuntimeCodexCredentials } = await import('./providerConfig.js?runtime-no-sync-secure-storage')

  const credentials = resolveRuntimeCodexCredentials({
    env: {} as NodeJS.ProcessEnv,
    storedCredentials: {
      accessToken: 'stored-access-token',
      accountId: 'acct_stored',
    },
  })

  expect(syncReadCalled).toBe(false)
  expect(credentials.source).toBe('secure-storage')
  expect(credentials.apiKey).toBe('stored-access-token')
  expect(credentials.accountId).toBe('acct_stored')
})

test('runtime credential resolution can read an explicitly selected local account', async () => {
  const readAccountIds: Array<string | undefined> = []
  mock.module('../../utils/codexCredentials.js', () => ({
    isCodexRefreshFailureCoolingDown: () => false,
    readCodexCredentials: (localAccountId?: string) => {
      readAccountIds.push(localAccountId)
      return {
        accessToken: 'selected-token',
        accountId: 'provider-selected',
      }
    },
  }))

  // @ts-expect-error cache-busting query string for Bun module mocks
  const { resolveRuntimeCodexCredentials } = await import('./providerConfig.js?selected-local-account')
  const credentials = resolveRuntimeCodexCredentials({
    env: {} as NodeJS.ProcessEnv,
    localAccountId: 'local-selected',
  })

  expect(readAccountIds).toEqual(['local-selected'])
  expect(credentials.source).toBe('secure-storage')
  expect(credentials.apiKey).toBe('selected-token')
  expect(credentials.accountId).toBe('provider-selected')
})
