import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { MSG } from './controller/protocol.js'

const background = await readFile(new URL('./background.js', import.meta.url), 'utf8')
const panel = await readFile(new URL('./panel/panel.js', import.meta.url), 'utf8')
const selectionContext = await readFile(new URL('./selectionContext.js', import.meta.url), 'utf8')

test('selection-context protocol is wired on both sides of the extension boundary', () => {
  for (const name of ['SELECTION_CONTEXT_GET', 'SELECTION_CONTEXT_DISCARD']) {
    assert.equal(typeof MSG[name], 'string')
    assert.match(background, new RegExp(`MSG\\.${name}`))
    assert.match(panel, new RegExp(`MSG\\.${name}`))
  }
  assert.equal(typeof MSG.SELECTION_CONTEXT_CHANGED, 'string')
  assert.match(selectionContext, /MSG\.SELECTION_CONTEXT_CHANGED/)
  assert.match(panel, /MSG\.SELECTION_CONTEXT_CHANGED/)
})

test('background registers the selected-text menu and consumes context before starting a turn', () => {
  assert.match(background, /installSelectionContextMenu\(\)/)
  assert.match(background, /chrome\.contextMenus\.onClicked\.addListener/)
  assert.match(background, /handleContextMenuClick\(info, tab\)/)
  assert.match(background, /consumePendingSelectionContext\(/)
  assert.match(background, /selectionContext/)
})
