import { afterEach, expect, mock, test } from 'bun:test'

const actualOauth = { ...(await import('../../constants/oauth.js')) }
let verbooMode = true
mock.module('../../constants/oauth.js', () => ({
  ...actualOauth,
  isVerbooMode: () => verbooMode,
}))

const { default: installGitHubApp } = await import('./index.js')
const savedDisable = process.env.DISABLE_INSTALL_GITHUB_APP_COMMAND

afterEach(() => {
  verbooMode = true
  if (savedDisable === undefined) delete process.env.DISABLE_INSTALL_GITHUB_APP_COMMAND
  else process.env.DISABLE_INSTALL_GITHUB_APP_COMMAND = savedDisable
})

test('is hidden in Verboo mode (it installs Anthropic\'s GitHub App)', () => {
  delete process.env.DISABLE_INSTALL_GITHUB_APP_COMMAND
  expect(installGitHubApp.isEnabled()).toBe(false)
})

test('stays available outside Verboo mode unless disabled by env', () => {
  verbooMode = false
  delete process.env.DISABLE_INSTALL_GITHUB_APP_COMMAND
  expect(installGitHubApp.isEnabled()).toBe(true)
  process.env.DISABLE_INSTALL_GITHUB_APP_COMMAND = '1'
  expect(installGitHubApp.isEnabled()).toBe(false)
})
