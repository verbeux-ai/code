/**
 * Driver for `marketplaceIntegration.test.ts`. Not bundled, not shipped.
 *
 * This runs in its own Bun process because Bun shares the `mock.module`
 * registry across test files in one process: sibling suites replace
 * `marketplaceManager` with partial mocks, so a full-stack fixture executed
 * inside the test runner would silently exercise a stub. The fixture only
 * *collects facts* — every assertion lives in the test file.
 *
 * Usage: bun run src/utils/plugins/marketplaceIntegration.fixture.ts
 * Emits one line: __MARKETPLACE_FIXTURE__<json>
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const RESULT_MARKER = '__MARKETPLACE_FIXTURE__'

const unknownSourceEntry = {
  name: 'xcode',
  source: {
    source: 'command',
    command: 'xcrun agent plugin path --plugin-format claude',
    mode: 'link',
  },
}

const root = await mkdtemp(join(tmpdir(), 'marketplace-fixture-'))
process.env.VERBOO_CONFIG_DIR = join(root, 'config')
process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = join(root, 'plugins')

const pluginsDir = join(root, 'plugins')

const { addMarketplaceSource, getMarketplace, getMarketplaceCacheOnly } =
  await import('./marketplaceManager.js')
const { detectAndUninstallDelistedPlugins } = await import('./pluginBlocklist.js')
const { getSkippedMarketplaceEntries } = await import('./schemas.js')
const { getInMemoryErrors } = await import('../../utils/log.js')
const { clearInstalledPluginsCache } = await import(
  './installedPluginsManager.js'
)

type Facts = Record<string, unknown>

function manifest(name: string, plugins: unknown[], extra = {}) {
  return { name, owner: { name: 'Test' }, plugins, ...extra }
}

async function writeManifestDir(dir: string, body: unknown) {
  await mkdir(join(dir, '.claude-plugin'), { recursive: true })
  await writeFile(
    join(dir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify(body, null, 2),
  )
}

async function writeInstalled(pluginIds: string[]) {
  await mkdir(pluginsDir, { recursive: true })
  const plugins: Record<string, unknown[]> = {}
  for (const pluginId of pluginIds) {
    plugins[pluginId] = [
      {
        scope: 'user',
        installPath: join(pluginsDir, 'cache', pluginId.replace('@', '/')),
        version: '1.0.0',
      },
    ]
  }
  await writeFile(
    join(pluginsDir, 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins }, null, 2),
  )
  // installedPluginsManager memoizes the file; drop the memo so the next
  // reader sees the fixture's state rather than an earlier scenario's.
  clearInstalledPluginsCache()
}

async function scenario(name: string, run: () => Promise<Facts>): Promise<Facts> {
  try {
    return await run()
  } catch (error) {
    return {
      scenario: name,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

const results: Facts[] = []

try {
  // 1. A directory marketplace whose catalog contains an entry this build can't
  //    parse. The rest of the catalog must survive.
  results.push(
    await scenario('directory', async () => {
      const dir = join(root, 'directory-marketplace')
      await writeManifestDir(
        dir,
        manifest('directory-marketplace', [
          { name: 'superpowers', source: './plugins/superpowers' },
          { name: 'frontend-design', source: './plugins/frontend-design' },
          unknownSourceEntry,
          { name: 'gopls-lsp', source: './plugins/gopls-lsp' },
        ]),
      )

      const added = await addMarketplaceSource({
        source: 'directory',
        path: dir,
      })
      const marketplace = await getMarketplace('directory-marketplace')
      const names = new Set(marketplace.plugins.map(plugin => plugin.name))

      return {
        scenario: 'directory',
        addedName: added.name,
        entryCount: marketplace.plugins.length,
        resolved: ['superpowers', 'frontend-design', 'gopls-lsp'].map(name => [
          name,
          names.has(name),
        ]),
        skipped: getSkippedMarketplaceEntries(marketplace).map(entry => ({
          name: entry.name,
          reason: entry.reason,
        })),
      }
    }),
  )

  // 2. Same catalog over HTTP. The cache must keep the manifest as published —
  //    writing the sanitized parse result would make the next cache read look
  //    clean and lose the skipped-entry record.
  results.push(
    await scenario('url', async () => {
      const body = JSON.stringify(
        manifest('url-marketplace', [
          { name: 'superpowers', source: './plugins/superpowers' },
          unknownSourceEntry,
        ]),
      )
      const server = Bun.serve({
        port: 0,
        fetch: () =>
          new Response(body, {
            headers: { 'content-type': 'application/json' },
          }),
      })
      try {
        await addMarketplaceSource({
          source: 'url',
          url: `http://127.0.0.1:${server.port}/marketplace.json`,
        })
        const marketplace = await getMarketplace('url-marketplace')
        const known = JSON.parse(
          await readFile(join(pluginsDir, 'known_marketplaces.json'), 'utf-8'),
        ) as Record<string, { installLocation: string }>
        const cached = JSON.parse(
          await readFile(known['url-marketplace']!.installLocation, 'utf-8'),
        ) as { plugins: Array<{ name: string }> }

        // Re-read from cache the way a fresh process would: the skipped entry
        // must still be detectable.
        const fromCache = await getMarketplaceCacheOnly('url-marketplace')

        return {
          scenario: 'url',
          entryCount: marketplace.plugins.length,
          skipped: getSkippedMarketplaceEntries(marketplace).map(e => e.name),
          cacheStillHasUnknownEntry: cached.plugins.some(
            p => p.name === 'xcode',
          ),
          skippedAfterCacheRead: fromCache
            ? getSkippedMarketplaceEntries(fromCache).map(e => e.name)
            : null,
        }
      } finally {
        server.stop(true)
      }
    }),
  )

  // 3. A manifest that is not a marketplace at all must still fail loudly.
  results.push(
    await scenario('broken', async () => {
      const dir = join(root, 'broken-marketplace')
      await writeManifestDir(dir, { plugins: [] })
      try {
        await addMarketplaceSource({ source: 'directory', path: dir })
        return { scenario: 'broken', rejected: false }
      } catch (error) {
        return {
          scenario: 'broken',
          rejected: true,
          message: error instanceof Error ? error.message : String(error),
        }
      }
    }),
  )

  // 4. Delisting enforcement: a dropped entry is not a removal.
  results.push(
    await scenario('delisting', async () => {
      await rm(pluginsDir, { recursive: true, force: true })
      await mkdir(pluginsDir, { recursive: true })

      const marketplaces = [
        {
          name: 'guarded-marketplace',
          forceRemoveDeletedPlugins: true,
          plugins: [
            { name: 'superpowers', source: './plugins/superpowers' },
            unknownSourceEntry,
          ],
        },
        {
          name: 'removing-marketplace',
          forceRemoveDeletedPlugins: true,
          plugins: [{ name: 'superpowers', source: './plugins/superpowers' }],
        },
        {
          name: 'passive-marketplace',
          forceRemoveDeletedPlugins: false,
          plugins: [],
        },
      ]

      const knownMarketplaces: Record<string, unknown> = {}
      for (const marketplace of marketplaces) {
        const dir = join(root, marketplace.name)
        await writeManifestDir(
          dir,
          manifest(marketplace.name, marketplace.plugins, {
            forceRemoveDeletedPlugins: marketplace.forceRemoveDeletedPlugins,
          }),
        )
        knownMarketplaces[marketplace.name] = {
          source: { source: 'directory', path: dir },
          installLocation: dir,
          lastUpdated: new Date().toISOString(),
        }
      }
      await writeFile(
        join(pluginsDir, 'known_marketplaces.json'),
        JSON.stringify(knownMarketplaces, null, 2),
      )

      await writeInstalled([
        'superpowers@guarded-marketplace',
        'xcode@guarded-marketplace',
        'superpowers@removing-marketplace',
        'gone@removing-marketplace',
        'superpowers@passive-marketplace',
      ])

      const flagged = await detectAndUninstallDelistedPlugins()
      const after = JSON.parse(
        await readFile(join(pluginsDir, 'installed_plugins.json'), 'utf-8'),
      ) as { plugins: Record<string, unknown> }

      const guarded = await getMarketplaceCacheOnly('guarded-marketplace')

      return {
        scenario: 'delisting',
        flagged,
        installedAfter: Object.keys(after.plugins).sort(),
        skippedSeenByEnforcement: guarded
          ? getSkippedMarketplaceEntries(guarded).map(entry => entry.name)
          : null,
      }
    }),
  )

  // 5. The load path that feeds `/plugin`: skipped entries must reach the
  //    caller, and the drop must land in the error log so it is diagnosable
  //    outside `--debug`.
  results.push(
    await scenario('graceful', async () => {
      const { loadMarketplacesWithGracefulDegradation } = await import(
        './marketplaceHelpers.js'
      )
      const config = JSON.parse(
        await readFile(join(pluginsDir, 'known_marketplaces.json'), 'utf-8'),
      ) as Record<string, never>

      const { skippedEntries } =
        await loadMarketplacesWithGracefulDegradation(config)

      return {
        scenario: 'graceful',
        skippedEntries,
        errorLogMentionsSkip: getInMemoryErrors().some(entry =>
          entry.error.includes(
            'guarded-marketplace" has 1 plugin entry this build cannot parse',
          ),
        ),
      }
    }),
  )

  // 6. The user-facing warning, including the rule that keeps it actionable:
  //    only warn when the unreadable entry is a plugin this user installed.
  results.push(
    await scenario('formatting', async () => {
      const { formatMarketplaceLoadingErrors } = await import(
        './marketplaceHelpers.js'
      )
      await writeInstalled(['xcode@claude-plugins-official'])

      return {
        scenario: 'formatting',
        onlySkipped: formatMarketplaceLoadingErrors(
          [],
          1,
          [{ name: 'claude-plugins-official', entries: ['xcode'] }],
        ),
        skippedNotInstalled: formatMarketplaceLoadingErrors(
          [],
          1,
          [{ name: 'claude-plugins-official', entries: ['some-uninstalled'] }],
        ),
        skippedWithFailure: formatMarketplaceLoadingErrors(
          [{ name: 'other-marketplace', error: 'boom' }],
          1,
          [{ name: 'claude-plugins-official', entries: ['xcode', 'y'] }],
        ),
        clean: formatMarketplaceLoadingErrors([], 2, []),
        allFailed: formatMarketplaceLoadingErrors(
          [{ name: 'other-marketplace', error: 'boom' }],
          0,
          [{ name: 'claude-plugins-official', entries: ['xcode'] }],
        ),
      }
    }),
  )
} finally {
  await rm(root, { recursive: true, force: true })
}

process.stdout.write(`${RESULT_MARKER}${JSON.stringify(results)}\n`)
