import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const html = await readFile(new URL('./panel.html', import.meta.url), 'utf8')
const script = await readFile(new URL('./panel.js', import.meta.url), 'utf8')
const styles = await readFile(new URL('./panel.css', import.meta.url), 'utf8')
const enUs = await readFile(new URL('../i18n/en-US.js', import.meta.url), 'utf8')
const ptBr = await readFile(new URL('../i18n/pt-BR.js', import.meta.url), 'utf8')

test('panel exposes an accessible clear-conversation action wired to the controller', () => {
  assert.match(html, /id="clear-chat"/)
  assert.match(html, /data-i18n-aria-label="chat_clearTitle"/)
  assert.match(script, /getElementById\('clear-chat'\)/)
  assert.match(script, /conversationHistory\s*=\s*\[\]/)
  assert.match(script, /replaceChildren\(\)/)
})

test('panel markup does not duplicate element IDs', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])
  assert.equal(new Set(ids).size, ids.length)
})

test('signed-out panel distinguishes the Verboo account from the desktop CLI connection', () => {
  assert.match(html, /class="login-connection-note"/)
  assert.match(html, /data-i18n="auth_accountLoginLabel"/)
  assert.match(html, /data-i18n="auth_accountLoginBody"/)
  assert.match(html, /data-i18n="auth_cliConnectionLabel"/)
  assert.match(html, /data-i18n="auth_cliConnectionBody"/)

  for (const bundle of [enUs, ptBr]) {
    assert.match(bundle, /"auth_accountLoginLabel"/)
    assert.match(bundle, /"auth_accountLoginBody"/)
    assert.match(bundle, /"auth_cliConnectionLabel"/)
    assert.match(bundle, /"auth_cliConnectionBody"/)
  }
})

test('panel exposes accessible routines, recording, slash, and variable controls', () => {
  for (const id of [
    'routines-btn',
    'record-workflow',
    'routine-slash-menu',
    'routine-variable-dialog',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`))
  }
  assert.match(
    html,
    /id="routines-btn"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"[^>]*aria-controls="routine-slash-menu"/s,
  )
  assert.match(html, /id="routine-slash-menu"[^>]*role="menu"/s)
  assert.match(
    html,
    /id="chat-input"[^>]*aria-autocomplete="list"[^>]*aria-controls="routine-slash-menu"/s,
  )
  assert.match(html, /id="routine-variable-dialog"[^>]*aria-labelledby="routine-variable-title"/s)
  assert.match(script, /aria-activedescendant/)
  assert.match(script, /MSG\.ROUTINE_LIST/)
  assert.match(script, /MSG\.ROUTINE_RUN/)
  assert.match(script, /MSG\.TOOL_PENDING_LIST/)
  assert.match(script, /toolCards\.has\(message\.toolCall\.id\)/)
})

test('recording-unavailable errors have localized user-facing copy', () => {
  assert.match(enUs, /"routine_recording_page_unavailable"/)
  assert.match(ptBr, /"routine_recording_page_unavailable"/)
})

test('composer supports multiline input without losing Enter-to-send behavior', () => {
  assert.match(html, /<textarea[^>]*\bid="chat-input"[^>]*\brows="1"[^>]*>/s)
  assert.match(script, /shouldSubmitComposerKey\(event\)/)
  assert.match(script, /form\.requestSubmit\(\)/)
  assert.match(script, /resizeChatInput\(input\)/)
})

test('composer grows within a limit and preserves user-authored line breaks', () => {
  assert.match(styles, /\.chat-input\s*\{[^}]*\bresize:\s*none/s)
  assert.match(styles, /\.chat-input\s*\{[^}]*\bmax-height:/s)
  assert.match(
    styles,
    /\.chat-message\[data-role="user"\]\s+\.chat-message-content\s*\{[^}]*white-space:\s*pre-wrap/s,
  )
})

test('panel exposes a removable selected-text context above the composer', () => {
  assert.match(html, /id="selection-context"[^>]*hidden/s)
  assert.match(html, /id="selection-context-count"[^>]*data-i18n="selection_context_count"/s)
  assert.match(html, /id="selection-context-warning"[^>]*hidden/s)
  assert.match(html, /id="selection-context-remove"[^>]*data-i18n-aria-label="selection_context_remove"/s)
  assert.match(styles, /\.selection-context\s*\{/)
  assert.match(script, /MSG\.SELECTION_CONTEXT_GET/)
  assert.match(script, /MSG\.SELECTION_CONTEXT_CHANGED/)
  assert.match(script, /MSG\.SELECTION_CONTEXT_DISCARD/)
  assert.match(script, /selectionContextId/)
  assert.match(script, /clearSelectionContext\(\)/)
  assert.match(script, /context\.verification === 'pending'[\s\S]*selection_context_verifying[\s\S]*selection_context_incomplete/)
  assert.match(script, /chrome\.tabs\.onActivated\.addListener/)
  assert.match(script, /handleSelectionContextChanged\(message\.context\)/)
  assert.doesNotMatch(script, /let selectionContextTabId/)

  for (const bundle of [enUs, ptBr]) {
    assert.match(bundle, /"selection_context_count"/)
    assert.match(bundle, /"selection_context_incomplete"/)
    assert.match(bundle, /"selection_context_remove"/)
  }
})
