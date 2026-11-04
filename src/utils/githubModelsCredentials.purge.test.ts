/**
 * VERBOO-BRAND: the GitHub Copilot login was retired; startup removes stored
 * tokens from the native vault and the plain-text fallback. No static import
 * of githubModelsCredentials so mock.module applies before it loads.
 */
import { afterEach, expect, mock, test } from 'bun:test'

afterEach(() => {
  mock.restore()
})

function memoryStorage(initial: Record<string, unknown> | null) {
  let data = initial
  return {
    get data() {
      return data
    },
    read: () => data,
    update: (next: Record<string, unknown>) => {
      data = next
      return { success: true }
    },
  }
}

test('removes stored Copilot tokens from the vault and the plain-text file', async () => {
  const vault = memoryStorage({
    githubModels: { accessToken: 'vault-token' },
    verbooOauth: { accessToken: 'keep-me' },
  })
  const plainText = memoryStorage({ githubModels: { accessToken: 'plain-token' } })
  mock.module('./secureStorage/index.js', () => ({ getSecureStorage: () => vault }))
  mock.module('./secureStorage/plainTextStorage.js', () => ({ plainTextStorage: plainText }))

  // @ts-expect-error cache-busting query string for Bun module isolation
  const { purgeGithubModelsCredentials } = await import('./githubModelsCredentials.js?purge=both')
  expect(purgeGithubModelsCredentials()).toBe(true)
  expect(vault.data).toEqual({ verbooOauth: { accessToken: 'keep-me' } })
  expect(plainText.data).toEqual({})
})

test('reports nothing removed when no Copilot login is stored', async () => {
  const vault = memoryStorage({ verbooOauth: { accessToken: 'keep-me' } })
  const plainText = memoryStorage(null)
  mock.module('./secureStorage/index.js', () => ({ getSecureStorage: () => vault }))
  mock.module('./secureStorage/plainTextStorage.js', () => ({ plainTextStorage: plainText }))

  // @ts-expect-error cache-busting query string for Bun module isolation
  const { purgeGithubModelsCredentials } = await import('./githubModelsCredentials.js?purge=none')
  expect(purgeGithubModelsCredentials()).toBe(false)
  expect(vault.data).toEqual({ verbooOauth: { accessToken: 'keep-me' } })
})
