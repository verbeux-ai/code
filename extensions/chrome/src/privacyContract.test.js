import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const privacyMarkdown = await readFile(new URL('../PRIVACY.md', import.meta.url), 'utf8')
const privacyHtml = await readFile(new URL('../privacy.html', import.meta.url), 'utf8')
const storeListing = await readFile(new URL('../STORE_LISTING.md', import.meta.url), 'utf8')
const permissions = await readFile(new URL('../PERMISSIONS.md', import.meta.url), 'utf8')
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')

test('privacy and listing disclose selected-text context menus and turn-only transmission', () => {
  for (const document of [privacyMarkdown, privacyHtml, storeListing]) {
    assert.match(document, /contextMenus/)
  }
  assert.match(privacyMarkdown, /only when you send a chat turn/i)
  assert.match(privacyHtml, /only when you send a chat turn/i)
  assert.match(storeListing, /only when the user sends a chat turn/i)
  assert.match(privacyMarkdown, /texto selecionado.*só.*enviado/i)
})

test('permission authorities stay synchronized with the manifest', () => {
  assert.match(permissions, /## `contextMenus`/)
  assert.match(permissions, /### `contextMenus`/)
  assert.match(readme, /contextMenus/)
})
