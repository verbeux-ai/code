import { getGlobalConfig } from '../../utils/config.js'
import {
  VERBOO_IN_CHROME_MCP_SERVER_NAME,
  VERBOO_IN_CHROME_TOOL_NAMES,
  getVerbooInChromePrompt,
  isManagedVerbooInChromeConfig,
  isVerbooInChromeDisabledByCli,
} from '../../utils/verbooInChrome.js'
import { registerBundledSkill } from '../bundledSkills.js'

const VERBOO_IN_CHROME_MCP_TOOLS = VERBOO_IN_CHROME_TOOL_NAMES.map(
  tool => `mcp__verboo-in-chrome__${tool}`,
)

function isConfigured(): boolean {
  if (isVerbooInChromeDisabledByCli()) return false
  return isManagedVerbooInChromeConfig(
    getGlobalConfig().mcpServers?.[VERBOO_IN_CHROME_MCP_SERVER_NAME],
  )
}

export function registerVerbooInChromeSkill(): void {
  registerBundledSkill({
    name: 'verboo-in-chrome',
    description:
      'Controls the user-approved Verboo Chrome extension to navigate pages, read content, click, type, capture screenshots, and manage tabs.',
    whenToUse:
      'Use when the user asks you to browse or interact with a website through their Chrome session. Invoke this skill before any mcp__verboo-in-chrome__* tool.',
    allowedTools: VERBOO_IN_CHROME_MCP_TOOLS,
    userInvocable: true,
    isEnabled: isConfigured,
    async getPromptForCommand(args) {
      const task = args ? `\n\n## Task\n\n${args}` : ''
      return [{ type: 'text', text: `${getVerbooInChromePrompt()}${task}` }]
    },
  })
}
