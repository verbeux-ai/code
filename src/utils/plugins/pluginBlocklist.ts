/**
 * Plugin delisting detection.
 *
 * Compares installed plugins against marketplace manifests to find plugins
 * that have been removed, and auto-uninstalls them.
 *
 * The security.json fetch was removed (see #25447) — ~29.5M/week GitHub hits
 * for UI reason/text only. If re-introduced, serve from downloads.claude.ai.
 */

import { uninstallPluginOp } from '../../services/plugins/pluginOperations.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { loadInstalledPluginsV2 } from './installedPluginsManager.js'
import {
  getMarketplace,
  loadKnownMarketplacesConfigSafe,
} from './marketplaceManager.js'
import {
  addFlaggedPlugin,
  getFlaggedPlugins,
  loadFlaggedPlugins,
} from './pluginFlagging.js'
import { getSkippedMarketplaceEntries } from './schemas.js'
import type { InstalledPluginsFileV2, PluginMarketplace } from './schemas.js'

/**
 * Detect plugins installed from a marketplace that are no longer listed there.
 *
 * @param installedPlugins All installed plugins
 * @param marketplace The marketplace to check against
 * @param marketplaceName The marketplace name suffix (e.g. "claude-plugins-official")
 * @returns List of delisted plugin IDs in "name@marketplace" format
 */
export function detectDelistedPlugins(
  installedPlugins: InstalledPluginsFileV2,
  marketplace: PluginMarketplace,
  marketplaceName: string,
): string[] {
  const marketplacePluginNames = new Set(marketplace.plugins.map(p => p.name))
  const suffix = `@${marketplaceName}`

  const delisted: string[] = []
  for (const pluginId of Object.keys(installedPlugins.plugins)) {
    if (!pluginId.endsWith(suffix)) continue

    const pluginName = pluginId.slice(0, -suffix.length)
    if (!marketplacePluginNames.has(pluginName)) {
      delisted.push(pluginId)
    }
  }

  return delisted
}

/**
 * Detect delisted plugins across all marketplaces, auto-uninstall them,
 * and record them as flagged.
 *
 * This is the core delisting enforcement logic, shared between interactive
 * mode (useManagePlugins) and headless mode (main.tsx print path).
 *
 * @returns List of newly flagged plugin IDs
 */
export async function detectAndUninstallDelistedPlugins(): Promise<string[]> {
  await loadFlaggedPlugins()

  const installedPlugins = loadInstalledPluginsV2()
  const alreadyFlagged = getFlaggedPlugins()
  // Read-only iteration — Safe variant so a corrupted config doesn't throw
  // out of this function (it's called in the same try-block as loadAllPlugins
  // in useManagePlugins, so a throw here would void loadAllPlugins' resilience).
  const knownMarketplaces = await loadKnownMarketplacesConfigSafe()
  const newlyFlagged: string[] = []

  for (const marketplaceName of Object.keys(knownMarketplaces)) {
    try {
      const marketplace = await getMarketplace(marketplaceName)

      if (!marketplace.forceRemoveDeletedPlugins) continue

      const delisted = detectDelistedPlugins(
        installedPlugins,
        marketplace,
        marketplaceName,
      )
      // A plugin whose marketplace entry failed validation is missing from the
      // parsed manifest, but the marketplace didn't remove it — dropping the
      // entry is our fallback, so never treat it as a removal.
      const skippedEntries = getSkippedMarketplaceEntries(marketplace)

      // If any dropped entry has no usable name, we cannot tell which plugin it
      // described: it could be the very plugin that now looks delisted. Deleting
      // a user's plugin is irreversible, so fail closed for this marketplace and
      // let a later parse (one without drops) decide. Entries that kept a usable
      // name are matched individually below, so delisting still works for the
      // common case.
      const unidentifiable = skippedEntries.filter(entry => !entry.identifiable)
      if (unidentifiable.length > 0) {
        if (delisted.length > 0) {
          logForDebugging(
            `Not enforcing delisting for "${marketplaceName}": ${unidentifiable.length} ` +
              `dropped entr${unidentifiable.length === 1 ? 'y has' : 'ies have'} no usable ` +
              `name, so a removal cannot be told apart from a parse failure`,
            { level: 'warn' },
          )
        }
        continue
      }

      const skipped = new Set(skippedEntries.map(entry => entry.name))
      const suffix = `@${marketplaceName}`

      for (const pluginId of delisted) {
        const pluginName = pluginId.slice(0, -suffix.length)
        if (skipped.has(pluginName)) {
          logForDebugging(
            `Not uninstalling ${pluginId}: its marketplace entry is invalid, not removed`,
            { level: 'warn' },
          )
          continue
        }
        if (pluginId in alreadyFlagged) continue

        // Skip managed-only plugins — enterprise admin should handle those
        const installations = installedPlugins.plugins[pluginId] ?? []
        const hasUserInstall = installations.some(
          i =>
            i.scope === 'user' || i.scope === 'project' || i.scope === 'local',
        )
        if (!hasUserInstall) continue

        // Auto-uninstall the delisted plugin from all user-controllable scopes
        for (const installation of installations) {
          const { scope } = installation
          if (scope !== 'user' && scope !== 'project' && scope !== 'local') {
            continue
          }
          try {
            await uninstallPluginOp(pluginId, scope)
          } catch (error) {
            logForDebugging(
              `Failed to auto-uninstall delisted plugin ${pluginId} from ${scope}: ${errorMessage(error)}`,
              { level: 'error' },
            )
          }
        }

        await addFlaggedPlugin(pluginId)
        newlyFlagged.push(pluginId)
      }
    } catch (error) {
      // Marketplace may not be available yet — log and continue
      logForDebugging(
        `Failed to check for delisted plugins in "${marketplaceName}": ${errorMessage(error)}`,
        { level: 'warn' },
      )
    }
  }

  return newlyFlagged
}
