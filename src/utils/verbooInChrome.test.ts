import assert from 'node:assert/strict'
import test from 'node:test'

import type { ScopedMcpServerConfig } from '../services/mcp/types.js'
import {
  VERBOO_IN_CHROME_MCP_SERVER_NAME,
  getVerbooInChromePrompt,
  isManagedVerbooInChromeConfig,
  isVerbooInChromeDisabledByCli,
  resolveVerbooInChromeMcpConfigs,
} from './verbooInChrome.js'

const managedChromeConfig: ScopedMcpServerConfig = {
  type: 'stdio',
  command: '/managed/verboo-in-chrome',
  args: ['mcp'],
  env: {
    VERBOO_IN_CHROME_MANAGED: '1',
    VERBOO_IN_CHROME_VERSION: '0.7.0-beta',
  },
  scope: 'user',
}

test('recognizes only the desktop-managed Verboo in Chrome contract', () => {
  assert.equal(isManagedVerbooInChromeConfig(managedChromeConfig), true)
  assert.equal(
    isManagedVerbooInChromeConfig({
      ...managedChromeConfig,
      env: { VERBOO_IN_CHROME_MANAGED: '0' },
    }),
    false,
  )
  assert.equal(
    isManagedVerbooInChromeConfig({
      type: 'http',
      url: 'https://example.test/mcp',
      scope: 'user',
    }),
    false,
  )
})

test('auto-enables the managed server without rewriting its cross-platform command', () => {
  const otherConfig: ScopedMcpServerConfig = {
    type: 'stdio',
    command: 'other-mcp',
    args: [],
    scope: 'user',
  }
  const configs = {
    other: otherConfig,
    [VERBOO_IN_CHROME_MCP_SERVER_NAME]: managedChromeConfig,
  }

  const resolved = resolveVerbooInChromeMcpConfigs(configs)

  assert.equal(resolved.enabled, true)
  assert.equal(resolved.requestedButMissing, false)
  assert.equal(
    resolved.configs[VERBOO_IN_CHROME_MCP_SERVER_NAME],
    managedChromeConfig,
  )
  assert.equal(resolved.configs.other, otherConfig)
})

test('--no-chrome disables only Verboo in Chrome for the current process', () => {
  const otherConfig: ScopedMcpServerConfig = {
    type: 'stdio',
    command: 'other-mcp',
    args: [],
    scope: 'user',
  }
  const resolved = resolveVerbooInChromeMcpConfigs(
    {
      other: otherConfig,
      [VERBOO_IN_CHROME_MCP_SERVER_NAME]: managedChromeConfig,
    },
    false,
  )

  assert.equal(resolved.enabled, false)
  assert.equal(resolved.requestedButMissing, false)
  assert.equal(
    VERBOO_IN_CHROME_MCP_SERVER_NAME in resolved.configs,
    false,
  )
  assert.equal(resolved.configs.other, otherConfig)
})

test('--chrome fails closed when the desktop-managed MCP is unavailable', () => {
  const resolved = resolveVerbooInChromeMcpConfigs({}, true)

  assert.equal(resolved.enabled, false)
  assert.equal(resolved.requestedButMissing, true)
})

test('the last per-session Chrome flag wins', () => {
  assert.equal(
    isVerbooInChromeDisabledByCli(['verboo', '--chrome', '--no-chrome']),
    true,
  )
  assert.equal(
    isVerbooInChromeDisabledByCli(['verboo', '--no-chrome', '--chrome']),
    false,
  )
})

test('browser guidance matches the tools exposed by the Verboo extension', () => {
  const prompt = getVerbooInChromePrompt()

  for (const tool of [
    'navigate',
    'read_page',
    'find',
    'extract_page_content',
    'structured_extract',
    'click',
    'type',
    'screenshot',
    'tabs',
    'tab_group',
  ]) {
    assert.match(prompt, new RegExp(`mcp__verboo-in-chrome__${tool}`))
  }
  assert.match(prompt, /background/i)
  assert.doesNotMatch(prompt, /mcp__claude-in-chrome__/)
})
