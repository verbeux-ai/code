import { afterEach, expect, test } from 'bun:test'

import { clearBundledSkills, getBundledSkills } from '../bundledSkills.js'
import { registerVerbooInChromeSkill } from './verbooInChrome.js'

afterEach(() => {
  clearBundledSkills()
})

test('Verboo in Chrome skill exposes the real MCP tool contract', async () => {
  registerVerbooInChromeSkill()

  const skill = getBundledSkills().find(
    command => command.name === 'verboo-in-chrome',
  )
  expect(skill).toBeDefined()
  expect(skill?.allowedTools).toEqual([
    'mcp__verboo-in-chrome__navigate',
    'mcp__verboo-in-chrome__read_page',
    'mcp__verboo-in-chrome__find',
    'mcp__verboo-in-chrome__extract_page_content',
    'mcp__verboo-in-chrome__structured_extract',
    'mcp__verboo-in-chrome__click',
    'mcp__verboo-in-chrome__type',
    'mcp__verboo-in-chrome__screenshot',
    'mcp__verboo-in-chrome__tabs',
    'mcp__verboo-in-chrome__tab_group',
  ])

  const blocks = await skill!.getPromptForCommand(
    'check the deployment status',
    {} as never,
  )
  const text = (blocks[0] as { text: string }).text
  expect(text).toContain('check the deployment status')
  expect(text).toContain('new background tab')
  expect(text).not.toContain('mcp__claude-in-chrome__')
})
