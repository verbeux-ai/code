import type { ScopedMcpServerConfig } from '../services/mcp/types.js'
import { normalizeNameForMCP } from '../services/mcp/normalization.js'

export const VERBOO_IN_CHROME_MCP_SERVER_NAME = 'verboo-in-chrome'
export const VERBOO_IN_CHROME_MANAGED_MARKER = 'VERBOO_IN_CHROME_MANAGED'

export const VERBOO_IN_CHROME_TOOL_NAMES = [
  'navigate',
  'read_page',
  'structured_extract',
  'click',
  'type',
  'screenshot',
  'tabs',
  'tab_group',
] as const

export function isVerbooInChromeMcpServer(name: string): boolean {
  return normalizeNameForMCP(name) === VERBOO_IN_CHROME_MCP_SERVER_NAME
}

export function isManagedVerbooInChromeConfig(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false

  const candidate = config as {
    type?: string
    command?: string
    args?: unknown
    env?: unknown
  }
  if (candidate.type !== undefined && candidate.type !== 'stdio') return false
  if (typeof candidate.command !== 'string' || candidate.command.length === 0) {
    return false
  }
  if (
    !Array.isArray(candidate.args) ||
    candidate.args.length !== 1 ||
    candidate.args[0] !== 'mcp'
  ) {
    return false
  }
  if (!candidate.env || typeof candidate.env !== 'object') return false

  return (
    (candidate.env as Record<string, unknown>)[
      VERBOO_IN_CHROME_MANAGED_MARKER
    ] === '1'
  )
}

export function resolveVerbooInChromeMcpConfigs(
  configs: Record<string, ScopedMcpServerConfig>,
  chromeFlag?: boolean,
): {
  configs: Record<string, ScopedMcpServerConfig>
  enabled: boolean
  requestedButMissing: boolean
} {
  const chromeEntry = Object.entries(configs).find(([name]) =>
    isVerbooInChromeMcpServer(name),
  )
  const managed = chromeEntry
    ? isManagedVerbooInChromeConfig(chromeEntry[1])
    : false

  if (chromeFlag === false) {
    return {
      configs: Object.fromEntries(
        Object.entries(configs).filter(
          ([name]) => !isVerbooInChromeMcpServer(name),
        ),
      ),
      enabled: false,
      requestedButMissing: false,
    }
  }

  return {
    configs,
    enabled: managed,
    requestedButMissing: chromeFlag === true && !managed,
  }
}

export function isVerbooInChromeDisabledByCli(
  argv: readonly string[] = process.argv,
): boolean {
  const chromeFlags = argv.filter(
    arg => arg === '--chrome' || arg === '--no-chrome',
  )
  return chromeFlags.at(-1) === '--no-chrome'
}

export function getVerbooInChromePrompt(): string {
  const tools = VERBOO_IN_CHROME_TOOL_NAMES.map(
    name => `- mcp__verboo-in-chrome__${name}`,
  ).join('\n')

  return `# Verboo in Chrome browser automation

You have access to the locally managed Verboo in Chrome MCP tools. Browser actions still pass through the extension's site permissions and approval flow.

Available tools:
${tools}

At the start of a browser task, call mcp__verboo-in-chrome__tabs with action \"list\" to get fresh tab IDs. Never reuse tab IDs from another task. Unless the user explicitly asks you to control an existing tab, open a new background tab with mcp__verboo-in-chrome__tabs and keep the user's foreground tab unchanged. Use mcp__verboo-in-chrome__navigate only after selecting the intended tab.

Stay focused on the requested task. If the extension is unavailable or an action fails repeatedly, stop after 2-3 attempts, explain what failed, and ask the user how to proceed.`
}
