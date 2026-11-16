import { access, mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { cleanupOrphanedPluginVersionsInBackground } from './cacheUtils.js'

let tempRoot: string
let originalPluginCacheDir: string | undefined
let originalZipCache: string | undefined

beforeEach(async () => {
  originalPluginCacheDir = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  originalZipCache = process.env.CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE
  tempRoot = await mkdtemp(join(tmpdir(), 'verboo-plugin-cache-cleanup-'))
  process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = join(tempRoot, 'plugins')
  delete process.env.CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE
})

afterEach(async () => {
  if (originalPluginCacheDir === undefined) {
    delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  } else {
    process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = originalPluginCacheDir
  }
  if (originalZipCache === undefined) {
    delete process.env.CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE
  } else {
    process.env.CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE = originalZipCache
  }
  await rm(tempRoot, { recursive: true, force: true })
})

async function cacheVersion(): Promise<string> {
  const versionPath = join(
    process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR!,
    'cache',
    'marketplace',
    'plugin',
    '1.0.0',
  )
  await mkdir(versionPath, { recursive: true })
  await writeFile(join(versionPath, 'plugin.txt'), 'keep me')
  return versionPath
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('cleanupOrphanedPluginVersionsInBackground', () => {
  test('keeps unlisted versions in a valid manifest without marking them orphaned', async () => {
    const versionPath = await cacheVersion()
    await writeFile(
      join(process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR!, 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: {} }),
    )

    await cleanupOrphanedPluginVersionsInBackground()

    expect(await pathExists(join(versionPath, 'plugin.txt'))).toBe(true)
    expect(await pathExists(join(versionPath, '.orphaned_at'))).toBe(false)
  })

  test('skips cleanup when the installed manifest is missing or invalid', async () => {
    for (const manifest of [undefined, '{ invalid json']) {
      const versionPath = await cacheVersion()
      const manifestPath = join(
        process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR!,
        'installed_plugins.json',
      )
      await rm(manifestPath, { force: true })
      if (manifest !== undefined) {
        await writeFile(manifestPath, manifest)
      }

      await cleanupOrphanedPluginVersionsInBackground()

      expect(await pathExists(join(versionPath, 'plugin.txt'))).toBe(true)
      expect(await pathExists(join(versionPath, '.orphaned_at'))).toBe(false)
    }
  })

  test('still deletes versions explicitly orphaned for more than seven days', async () => {
    const versionPath = await cacheVersion()
    await writeFile(
      join(process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR!, 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: {} }),
    )
    const markerPath = join(versionPath, '.orphaned_at')
    await writeFile(markerPath, String(Date.now() - 8 * 24 * 60 * 60 * 1000))
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    await utimes(markerPath, old, old)

    await cleanupOrphanedPluginVersionsInBackground()

    let exists = true
    try {
      await stat(versionPath)
    } catch {
      exists = false
    }
    expect(exists).toBe(false)
  })
})
