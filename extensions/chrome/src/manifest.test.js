import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const manifest = JSON.parse(
  await readFile(new URL('../manifest.json', import.meta.url), 'utf8'),
)
const background = await readFile(new URL('./background.js', import.meta.url), 'utf8')
const enMessages = JSON.parse(
  await readFile(new URL('../_locales/en/messages.json', import.meta.url), 'utf8'),
)
const ptBrMessages = JSON.parse(
  await readFile(new URL('../_locales/pt_BR/messages.json', import.meta.url), 'utf8'),
)

test('manifest advertises Native Messaging for the packaged MCP host', () => {
  assert.equal(manifest.permissions.includes('nativeMessaging'), true)
})

test('manifest declares identity for user-initiated OAuth PKCE', () => {
  assert.equal(manifest.permissions.includes('identity'), true)
})

test('manifest declares scheduling and notification capabilities for local routines', () => {
  assert.equal(manifest.permissions.includes('alarms'), true)
  assert.equal(manifest.permissions.includes('notifications'), true)
})

test('manifest requires context menus for selected-text entry points', () => {
  assert.equal(manifest.permissions.includes('contextMenus'), true)
})

test('selected-text menu labels are localized in English and Portuguese', () => {
  assert.equal(enMessages.contextMenuAskVerboo?.message, 'Ask Verboo')
  assert.equal(ptBrMessages.contextMenuAskVerboo?.message, 'Perguntar ao Verboo')
})

test('service worker tolerates an existing install awaiting new routine permissions', () => {
  assert.match(background, /const alarmsApi = chrome\.alarms \?\?/)
  assert.match(background, /chrome\.alarms\?\.onAlarm\?\.addListener/)
  assert.match(background, /chrome\.notifications\?\.onClicked\?\.addListener/)
})
