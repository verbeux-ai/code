import { feature } from 'bun:bundle'
import { initAutoDream } from '../services/autoDream/autoDream.js'
import { initMagicDocs } from '../services/MagicDocs/magicDocs.js'
import { initSkillImprovement } from './hooks/skillImprovement.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const extractMemoriesModule = feature('EXTRACT_MEMORIES')
  ? (require('../services/extractMemories/extractMemories.js') as typeof import('../services/extractMemories/extractMemories.js'))
  : null
const registerProtocolModule = feature('LODESTONE')
  ? (require('./deepLink/registerProtocol.js') as typeof import('./deepLink/registerProtocol.js'))
  : null

/* eslint-enable @typescript-eslint/no-require-imports */

import { getIsInteractive, getLastInteractionTime } from '../bootstrap/state.js'
import {
  cleanupNpmCacheForAnthropicPackages,
  cleanupOldMessageFilesInBackground,
  cleanupOldVersionsThrottled,
} from './cleanup.js'
import { cleanupOldVersions } from './nativeInstaller/index.js'
import { autoUpdateMarketplacesAndPluginsInBackground } from './plugins/pluginAutoupdate.js'
import {
  getLatestVersion,
  installGlobalPackage,
} from './autoUpdater.js'
import { getCurrentInstallationType } from './doctorDiagnostic.js'
import { localInstallationExists, installOrUpdateClaudePackage } from './localInstaller.js'
import { gte } from './semver.js'
import { getInitialSettings } from './settings/settings.js'
import { writeToStdout } from './process.js'
import { isAutoUpdaterDisabled } from './config.js'

// 24 hours in milliseconds
const RECURRING_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000

// 10 minutes after start.
const DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION = 10 * 60 * 1000

async function autoUpdateCliInBackground(): Promise<void> {
  try {
    if (isAutoUpdaterDisabled()) return

    const installationType = await getCurrentInstallationType()
    if (installationType === 'development') return

    const channel = getInitialSettings()?.autoUpdatesChannel ?? 'latest'
    const latest = await getLatestVersion(channel)
    if (!latest || gte(MACRO.DISPLAY_VERSION, latest)) return

    writeToStdout(`\nNova versão disponível: ${latest} (atual: ${MACRO.DISPLAY_VERSION})\n`)
    writeToStdout('Atualizando automaticamente...\n')

    const isLocal = await localInstallationExists()
    const status = isLocal
      ? await installOrUpdateClaudePackage(channel)
      : await installGlobalPackage()

    if (status === 'success') {
      writeToStdout(`✓ Atualizado para ${latest}. Reinicie o Verboo para usar a nova versão.\n\n`)
    }
  } catch {
    // silently ignore — falhas de update não devem afetar a sessão
  }
}

export function startBackgroundHousekeeping(): void {
  void autoUpdateCliInBackground()
  void initMagicDocs()
  void initSkillImprovement()
  if (feature('EXTRACT_MEMORIES')) {
    extractMemoriesModule!.initExtractMemories()
  }
  initAutoDream()
  void autoUpdateMarketplacesAndPluginsInBackground()
  if (feature('LODESTONE') && getIsInteractive()) {
    void registerProtocolModule!.ensureDeepLinkProtocolRegistered()
  }

  let needsCleanup = true
  async function runVerySlowOps(): Promise<void> {
    // If the user did something in the last minute, don't make them wait for these slow operations to run.
    if (
      getIsInteractive() &&
      getLastInteractionTime() > Date.now() - 1000 * 60
    ) {
      setTimeout(
        runVerySlowOps,
        DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION,
      ).unref()
      return
    }

    if (needsCleanup) {
      needsCleanup = false
      await cleanupOldMessageFilesInBackground()
    }

    // If the user did something in the last minute, don't make them wait for these slow operations to run.
    if (
      getIsInteractive() &&
      getLastInteractionTime() > Date.now() - 1000 * 60
    ) {
      setTimeout(
        runVerySlowOps,
        DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION,
      ).unref()
      return
    }

    await cleanupOldVersions()
  }

  setTimeout(
    runVerySlowOps,
    DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION,
  ).unref()

  // For long-running sessions, schedule recurring cleanup every 24 hours.
  // Both cleanup functions use marker files and locks to throttle to once per day
  // and skip immediately if another process holds the lock.
  if (process.env.USER_TYPE === 'ant') {
    const interval = setInterval(() => {
      void cleanupNpmCacheForAnthropicPackages()
      void cleanupOldVersionsThrottled()
    }, RECURRING_CLEANUP_INTERVAL_MS)

    // Don't let this interval keep the process alive
    interval.unref()
  }
}
