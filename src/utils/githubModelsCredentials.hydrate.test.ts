/**
 * Hydrate tests live in a separate file with no static import of
 * githubModelsCredentials so Bun's mock.module can replace secureStorage
 * before that module is first loaded.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'

describe('hydrateGithubModelsTokenFromSecureStorage', () => {
  const orig = {
    CLAUDE_CODE_USE_GITHUB: process.env.CLAUDE_CODE_USE_GITHUB,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GH_TOKEN: process.env.GH_TOKEN,
    CLAUDE_CODE_GITHUB_TOKEN_HYDRATED:
      process.env.CLAUDE_CODE_GITHUB_TOKEN_HYDRATED,
    CLAUDE_CODE_SIMPLE: process.env.CLAUDE_CODE_SIMPLE,
  }

  afterEach(() => {
    mock.restore()
    for (const [k, v] of Object.entries(orig)) {
      if (v === undefined) {
        delete process.env[k as keyof typeof orig]
      } else {
        process.env[k as keyof typeof orig] = v
      }
    }
  })

  // VERBOO-BRAND: o login GitHub Copilot foi removido; tokens salvos são ignorados.
  test('ignores stored Copilot tokens even when USE_GITHUB is set', async () => {
    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    delete process.env.GITHUB_TOKEN
    delete process.env.GH_TOKEN
    delete process.env.CLAUDE_CODE_SIMPLE

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => ({
          githubModels: { accessToken: 'stored-secret' },
        }),
      }),
    }))

    const { hydrateGithubModelsTokenFromSecureStorage } = await import(
      './githubModelsCredentials.js?hydrate=sets-token'
    )
    hydrateGithubModelsTokenFromSecureStorage()
    expect(process.env.GITHUB_TOKEN).toBeUndefined()
    expect(process.env.CLAUDE_CODE_GITHUB_TOKEN_HYDRATED).toBeUndefined()
  })

  test('does not override existing GITHUB_TOKEN', async () => {
    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    process.env.GITHUB_TOKEN = 'already'
    delete process.env.CLAUDE_CODE_GITHUB_TOKEN_HYDRATED

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => ({
          githubModels: { accessToken: 'stored-secret' },
        }),
      }),
    }))

    const { hydrateGithubModelsTokenFromSecureStorage } = await import(
      './githubModelsCredentials.js?hydrate=preserve-existing'
    )
    hydrateGithubModelsTokenFromSecureStorage()
    expect(process.env.GITHUB_TOKEN).toBe('already')
    expect(process.env.CLAUDE_CODE_GITHUB_TOKEN_HYDRATED).toBeUndefined()
  })
})
