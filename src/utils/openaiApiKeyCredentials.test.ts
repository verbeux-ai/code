import { afterEach, expect, mock, test } from 'bun:test'

afterEach(() => {
  mock.restore()
})

test('recognizes OpenAI keys and rejects Anthropic keys or typos', async () => {
  const { looksLikeOpenAIApiKey } = await import('./openaiApiKeyCredentials.js')
  expect(looksLikeOpenAIApiKey('sk-proj-abcdefghijklmnopqrstuvwx')).toBe(true)
  expect(looksLikeOpenAIApiKey('sk-abcdefghijklmnopqrstuvwxyz1234')).toBe(true)
  expect(looksLikeOpenAIApiKey('sk-ant-api03-abcdefghijklmnopqrstuvwx')).toBe(false)
  expect(looksLikeOpenAIApiKey('sk-short')).toBe(false)
})

test('stores, reads and clears the key without touching other entries', async () => {
  let state: Record<string, unknown> | null = { verbooOauth: { accessToken: 'keep-me' } }
  mock.module('./secureStorage/index.js', () => ({
    getSecureStorage: () => ({
      read: () => state,
      readAsync: async () => state,
      update: (next: Record<string, unknown>) => {
        state = next
        return { success: true }
      },
    }),
  }))
  mock.module('./envUtils.js', () => ({ isBareMode: () => false }))
  // @ts-expect-error cache-busting query string for Bun module isolation
  const credentials = await import('./openaiApiKeyCredentials.js?storage')

  const key = credentials.buildOpenAIApiKeyCredential('  sk-proj-abcdefghijklmnopqrstuvwx  ')
  expect(credentials.saveOpenAIApiKeyCredential(key).success).toBe(true)
  expect(credentials.readOpenAIApiKeyCredential()).toEqual({
    apiKey: 'sk-proj-abcdefghijklmnopqrstuvwx',
    keyHint: 'uvwx',
  })
  expect(await credentials.readOpenAIApiKeyCredentialAsync()).toMatchObject({ keyHint: 'uvwx' })

  expect(credentials.clearOpenAIApiKeyCredential().success).toBe(true)
  expect(credentials.readOpenAIApiKeyCredential()).toBeUndefined()
  expect(state).toEqual({ verbooOauth: { accessToken: 'keep-me' } })
})
