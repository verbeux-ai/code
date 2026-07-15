import { beforeEach, describe, expect, mock, test } from 'bun:test'

type TestGlobalConfig = {
  nativeMarketplaceAutoInstall?: Record<
    string,
    {
      attempted?: boolean
      installed?: boolean
      failReason?: 'policy_blocked' | 'git_unavailable' | 'gcs_unavailable' | 'unknown'
      retryCount?: number
      lastAttemptTime?: number
      nextRetryTime?: number
    }
  >
  officialMarketplaceAutoInstallAttempted?: boolean
  officialMarketplaceAutoInstalled?: boolean
  officialMarketplaceAutoInstallFailReason?:
    | 'policy_blocked'
    | 'git_unavailable'
    | 'gcs_unavailable'
    | 'unknown'
  officialMarketplaceAutoInstallRetryCount?: number
  officialMarketplaceAutoInstallLastAttemptTime?: number
  officialMarketplaceAutoInstallNextRetryTime?: number
}

let config: TestGlobalConfig = {}
let knownMarketplaces: Record<string, unknown> = {}
const saveGlobalConfig = mock(
  (updater: (current: TestGlobalConfig) => TestGlobalConfig) => {
    config = updater(config)
  },
)
const saveKnownMarketplacesConfig = mock(
  async (next: Record<string, unknown>) => {
    knownMarketplaces = next
  },
)
const fetchOfficialMarketplaceFromGcs = mock(async () => 'sha')
const addMarketplaceSource = mock(async () => ({
  name: 'claude-plugins-official',
  alreadyMaterialized: false,
  resolvedSource: {},
}))
const refreshMarketplace = mock(async () => {})

mock.module('../../services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => true,
}))

mock.module('../../services/analytics/index.js', () => ({
  logEvent: mock(() => {}),
}))

mock.module('../config.js', () => ({
  getGlobalConfig: () => config,
  saveGlobalConfig,
}))

mock.module('../debug.js', () => ({
  logForDebugging: mock(() => {}),
}))

mock.module('../log.js', () => ({
  logError: mock(() => {}),
}))

mock.module('./gitAvailability.js', () => ({
  checkGitAvailable: async () => true,
  markGitUnavailable: mock(() => {}),
}))

mock.module('./marketplaceHelpers.js', () => ({
  isSourceAllowedByPolicy: () => true,
}))

mock.module('./marketplaceManager.js', () => ({
  addMarketplaceSource,
  getMarketplacesCacheDir: () => '/tmp/verboo-marketplaces',
  loadKnownMarketplacesConfig: async () => knownMarketplaces,
  refreshMarketplace,
  saveKnownMarketplacesConfig,
}))

mock.module('./officialMarketplaceGcs.js', () => ({
  fetchOfficialMarketplaceFromGcs,
}))

const {
  checkAndInstallNativeMarketplaces,
  checkAndInstallOfficialMarketplace,
  checkAndInstallVerbooMarketplace,
  prepareVerbooMarketplaceForExplicitInstall,
} = await import(
  './officialMarketplaceStartupCheck.js'
)

beforeEach(() => {
  config = {}
  knownMarketplaces = {}
  saveGlobalConfig.mockClear()
  saveKnownMarketplacesConfig.mockClear()
  fetchOfficialMarketplaceFromGcs.mockClear()
  fetchOfficialMarketplaceFromGcs.mockImplementation(async () => 'sha')
  addMarketplaceSource.mockClear()
  addMarketplaceSource.mockImplementation(async () => ({
    name: 'claude-plugins-official',
    alreadyMaterialized: false,
    resolvedSource: {},
  }))
  refreshMarketplace.mockClear()
})

describe('checkAndInstallOfficialMarketplace', () => {
  test('repairs missing known marketplace even when global config says installed', async () => {
    config = {
      officialMarketplaceAutoInstallAttempted: true,
      officialMarketplaceAutoInstalled: true,
    }

    const result = await checkAndInstallOfficialMarketplace()

    expect(result).toEqual({ installed: true, skipped: false })
    expect(fetchOfficialMarketplaceFromGcs).toHaveBeenCalled()
    expect(saveKnownMarketplacesConfig).toHaveBeenCalled()
    expect(knownMarketplaces).toHaveProperty('claude-plugins-official')
    expect(config.officialMarketplaceAutoInstalled).toBe(true)
    expect(config.officialMarketplaceAutoInstallFailReason).toBeUndefined()
  })

  test('uses known marketplaces as the installed source of truth', async () => {
    knownMarketplaces = {
      'claude-plugins-official': {
        installLocation: '/tmp/verboo-marketplaces/claude-plugins-official',
      },
    }

    const result = await checkAndInstallOfficialMarketplace()

    expect(result).toEqual({
      installed: false,
      skipped: true,
      reason: 'already_installed',
    })
    expect(fetchOfficialMarketplaceFromGcs).not.toHaveBeenCalled()
    expect(config.officialMarketplaceAutoInstallAttempted).toBe(true)
    expect(config.officialMarketplaceAutoInstalled).toBe(true)
  })
})

describe('checkAndInstallVerbooMarketplace', () => {
  test('installs Verboo for an existing Claude marketplace user', async () => {
    knownMarketplaces = {
      'claude-plugins-official': {
        installLocation: '/tmp/verboo-marketplaces/claude-plugins-official',
      },
    }
    config = {
      officialMarketplaceAutoInstallAttempted: true,
      officialMarketplaceAutoInstalled: true,
    }

    const result = await checkAndInstallVerbooMarketplace()

    expect(result).toEqual({ installed: true, skipped: false })
    expect(addMarketplaceSource).toHaveBeenCalledWith({
      source: 'url',
      url: 'https://code.verboo.ai/api/plugins/marketplace.json',
    })
    expect(config.nativeMarketplaceAutoInstall?.['verboo-plugins']).toMatchObject({
      attempted: true,
      installed: true,
    })
  })

  test('uses known marketplaces as the Verboo installed source of truth', async () => {
    knownMarketplaces = {
      'verboo-plugins': {
        installLocation: '/tmp/verboo-marketplaces/verboo-plugins.json',
      },
    }

    const result = await checkAndInstallVerbooMarketplace()

    expect(result).toEqual({
      installed: false,
      skipped: true,
      reason: 'already_installed',
    })
    expect(addMarketplaceSource).not.toHaveBeenCalled()
  })

  test('persists the Verboo auto-update default without overwriting an opt-out', async () => {
    knownMarketplaces = {
      'verboo-plugins': {
        installLocation: '/tmp/verboo-marketplaces/verboo-plugins.json',
      },
    }

    await checkAndInstallVerbooMarketplace()

    expect(
      (knownMarketplaces['verboo-plugins'] as { autoUpdate?: boolean })
        .autoUpdate,
    ).toBe(true)

    knownMarketplaces = {
      'verboo-plugins': {
        installLocation: '/tmp/verboo-marketplaces/verboo-plugins.json',
        autoUpdate: false,
      },
    }
    saveKnownMarketplacesConfig.mockClear()

    await checkAndInstallVerbooMarketplace()

    expect(
      (knownMarketplaces['verboo-plugins'] as { autoUpdate?: boolean })
        .autoUpdate,
    ).toBe(false)
    expect(saveKnownMarketplacesConfig).not.toHaveBeenCalled()
  })

  test('coalesces concurrent automatic Verboo setup work', async () => {
    let releaseAdd: (() => void) | undefined
    let markAddStarted: (() => void) | undefined
    const addStarted = new Promise<void>(resolve => {
      markAddStarted = resolve
    })
    addMarketplaceSource.mockImplementation(async () => {
      markAddStarted?.()
      await new Promise<void>(resolve => {
        releaseAdd = resolve
      })
      knownMarketplaces['verboo-plugins'] = {
        installLocation: '/tmp/verboo-marketplaces/verboo-plugins.json',
      }
      return {
        name: 'verboo-plugins',
        alreadyMaterialized: false,
        resolvedSource: {},
      }
    })

    const first = checkAndInstallVerbooMarketplace()
    const second = checkAndInstallVerbooMarketplace()

    await addStarted
    expect(first).toBe(second)
    expect(addMarketplaceSource).toHaveBeenCalledTimes(1)

    releaseAdd?.()
    await Promise.all([first, second])
  })

  test('refreshes the native marketplace before an explicit plugin install', async () => {
    knownMarketplaces = {
      'verboo-plugins': {
        installLocation: '/tmp/verboo-marketplaces/verboo-plugins.json',
        autoUpdate: false,
      },
    }

    await prepareVerbooMarketplaceForExplicitInstall()

    expect(addMarketplaceSource).not.toHaveBeenCalled()
    expect(refreshMarketplace).toHaveBeenCalledWith('verboo-plugins')
    expect(
      (knownMarketplaces['verboo-plugins'] as { autoUpdate?: boolean })
        .autoUpdate,
    ).toBe(false)
  })

  test('does not fall back to a stale marketplace when explicit refresh fails', async () => {
    knownMarketplaces = {
      'verboo-plugins': {
        installLocation: '/tmp/verboo-marketplaces/verboo-plugins.json',
      },
    }
    refreshMarketplace.mockImplementationOnce(async () => {
      throw new Error('manifest unavailable')
    })

    await expect(prepareVerbooMarketplaceForExplicitInstall()).rejects.toThrow(
      'manifest unavailable',
    )
  })

  test('materializes and refreshes Verboo for an explicit install even after auto-install is skipped', async () => {
    const previous =
      process.env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL
    process.env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL = '1'
    addMarketplaceSource.mockImplementation(async () => {
      knownMarketplaces['verboo-plugins'] = {
        installLocation: '/tmp/verboo-marketplaces/verboo-plugins.json',
      }
      return {
        name: 'verboo-plugins',
        alreadyMaterialized: false,
        resolvedSource: {},
      }
    })

    try {
      await prepareVerbooMarketplaceForExplicitInstall()
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL
      } else {
        process.env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL =
          previous
      }
    }

    expect(addMarketplaceSource).toHaveBeenCalledWith({
      source: 'url',
      url: 'https://code.verboo.ai/api/plugins/marketplace.json',
    })
    expect(refreshMarketplace).toHaveBeenCalledWith('verboo-plugins')
    expect(
      (knownMarketplaces['verboo-plugins'] as { autoUpdate?: boolean })
        .autoUpdate,
    ).toBe(true)
  })

  test('keeps installing Claude when the Verboo request fails', async () => {
    addMarketplaceSource.mockImplementationOnce(async () => {
      throw new Error('Verboo endpoint unavailable')
    })

    const result = await checkAndInstallNativeMarketplaces()

    expect(result.verboo).toMatchObject({
      installed: false,
      skipped: true,
      reason: 'unknown',
    })
    expect(result.claude).toEqual({ installed: true, skipped: false })
    expect(fetchOfficialMarketplaceFromGcs).toHaveBeenCalled()
  })
})
