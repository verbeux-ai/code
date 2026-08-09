import * as React from 'react'
import { Text } from '../ink.js'
import { getGlobalConfig } from '../utils/config.js'
import {
  VERBOO_IN_CHROME_MCP_SERVER_NAME,
  isManagedVerbooInChromeConfig,
  isVerbooInChromeDisabledByCli,
} from '../utils/verbooInChrome.js'
import { useStartupNotification } from './notifs/useStartupNotification.js'

function wasExplicitlyRequested(): boolean {
  return process.argv.includes('--chrome')
}

export function useChromeExtensionNotification(): void {
  useStartupNotification(async () => {
    if (isVerbooInChromeDisabledByCli()) return null

    const configured = isManagedVerbooInChromeConfig(
      getGlobalConfig().mcpServers?.[VERBOO_IN_CHROME_MCP_SERVER_NAME],
    )
    if (!configured) {
      if (!wasExplicitlyRequested()) return null
      return {
        key: 'verboo-in-chrome-not-configured',
        jsx: (
          <Text color="error">
            Verboo in Chrome is not configured in the desktop app
          </Text>
        ),
        priority: 'immediate',
        timeoutMs: 5000,
      }
    }

    return {
      key: 'verboo-in-chrome-enabled',
      text: 'Verboo in Chrome enabled · /chrome',
      priority: 'low',
    }
  })
}
