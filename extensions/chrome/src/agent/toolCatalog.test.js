/**
 * toolCatalog.test.js — tests for tool catalog shape and helpers.
 * Run: node --test src/agent/toolCatalog.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OPENAI_TOOLS, getToolRisk, toToolCall } from './toolCatalog.js'

test('OPENAI_TOOLS: is derived from the executable browser tools', () => {
  assert.equal(OPENAI_TOOLS.length, 10)
  const names = OPENAI_TOOLS.map(t => t.function.name)
  assert.deepEqual(names, ['navigate', 'read_page', 'find', 'extract_page_content', 'structured_extract', 'click', 'type', 'screenshot', 'tabs', 'tab_group'])
})

test('OPENAI_TOOLS: find requires text (discovery primitive)', () => {
  const find = OPENAI_TOOLS.find(t => t.function.name === 'find')
  assert.ok(find)
  assert.deepEqual(find.function.parameters.required, ['text'])
  assert.equal(find.function.parameters.properties.text.type, 'string')
})

test('OPENAI_TOOLS: extract_page_content has no required params (full-page read)', () => {
  const extract = OPENAI_TOOLS.find(t => t.function.name === 'extract_page_content')
  assert.ok(extract)
  assert.ok(!extract.function.parameters.required || extract.function.parameters.required.length === 0)
  assert.match(extract.function.description, /full|entire|truncat/i)
})

test('OPENAI_TOOLS: navigate has required url param', () => {
  const nav = OPENAI_TOOLS.find(t => t.function.name === 'navigate')
  assert.ok(nav)
  assert.deepEqual(nav.function.parameters.required, ['url'])
  assert.equal(nav.function.parameters.properties.url.type, 'string')
})

test('OPENAI_TOOLS: click has required selector param', () => {
  const click = OPENAI_TOOLS.find(t => t.function.name === 'click')
  assert.ok(click)
  assert.deepEqual(click.function.parameters.required, ['selector'])
})

test('OPENAI_TOOLS: type has required selector + text', () => {
  const type = OPENAI_TOOLS.find(t => t.function.name === 'type')
  assert.ok(type)
  assert.deepEqual(type.function.parameters.required, ['selector', 'text'])
})

test('OPENAI_TOOLS: screenshot has no required params', () => {
  const ss = OPENAI_TOOLS.find(t => t.function.name === 'screenshot')
  assert.ok(ss)
  assert.ok(!ss.function.parameters.required || ss.function.parameters.required.length === 0)
})

test('OPENAI_TOOLS: tabs has required action', () => {
  const tabs = OPENAI_TOOLS.find(t => t.function.name === 'tabs')
  assert.ok(tabs)
  assert.deepEqual(tabs.function.parameters.required, ['action'])
  assert.match(tabs.function.description, /new tab/i)
  assert.match(tabs.function.description, /do not use navigate/i)
})

test('getToolRisk: returns correct risk class for known tools', () => {
  assert.equal(getToolRisk('navigate'), 'mutate')
  assert.equal(getToolRisk('read_page'), 'read')
  assert.equal(getToolRisk('structured_extract'), 'read')
  assert.equal(getToolRisk('click'), 'mutate')
  assert.equal(getToolRisk('type'), 'mutate')
  assert.equal(getToolRisk('screenshot'), 'read')
  assert.equal(getToolRisk('tabs'), 'mutate')
})

test('getToolRisk: falls back to elevated for unknown tools (fail-safe)', () => {
  assert.equal(getToolRisk('unknown_tool'), 'elevated')
  assert.equal(getToolRisk(''), 'elevated')
})

test('toToolCall: leaves policy metadata for the controller to derive', () => {
  const tc = toToolCall({
    id: 'tc_abc',
    name: 'navigate',
    arguments: '{"url":"https://example.com"}',
  })
  assert.equal(tc.id, 'tc_abc')
  assert.equal(tc.name, 'navigate')
  assert.equal(tc.params.url, 'https://example.com')
  assert.equal('risk' in tc, false)
  assert.equal('input' in tc, false)
})

test('toToolCall: handles malformed arguments gracefully', () => {
  const tc = toToolCall({ id: 'tc_bad', name: 'click', arguments: 'not json' })
  assert.deepEqual(tc.params, {})
  assert.equal(tc.name, 'click')
})

test('toToolCall: screenshot with empty arguments', () => {
  const tc = toToolCall({ id: 'tc_ss', name: 'screenshot', arguments: '{}' })
  assert.deepEqual(tc.params, {})
})

test('toToolCall: unknown tool is passed without caller-owned risk metadata', () => {
  const tc = toToolCall({ id: 'tc_x', name: 'execute_sql', arguments: '{}' })
  assert.equal(tc.name, 'execute_sql')
  assert.equal('risk' in tc, false)
})
