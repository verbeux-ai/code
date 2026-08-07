import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findTool } from './find.js'

/**
 * G1-CHROME: the model must be able to DISCOVER a real, clickable reference
 * for a target the user names — never guess CSS selectors from memory.
 * A playlist called "ela" must be locatable by visible text and come back
 * with a working selector derived from the actual element.
 */

function element(tag, attrs = {}, text = '') {
  const el = {
    tagName: tag.toUpperCase(),
    innerText: text,
    textContent: text,
    getAttribute: (name) => attrs[name] ?? null,
    parentElement: null,
  }
  if (attrs.href) el.href = attrs.href
  return el
}

function fakePage(elements) {
  return {
    querySelectorAll: (selector) => {
      if (selector.includes('[role="button"]') || selector.includes('a, button')) {
        return elements
      }
      return []
    },
  }
}

test('G1 find: locates a playlist by its visible name and returns the REAL clickable reference', async () => {
  const originalChrome = globalThis.chrome
  const originalDocument = globalThis.document
  const playlistLink = element(
    'a',
    { href: 'https://www.youtube.com/playlist?list=WL4E2A1B9' },
    'Minha playlist ela',
  )
  const otherLink = element('a', { href: 'https://www.youtube.com/playlist?list=WL000' }, 'Favoritos antigos')

  globalThis.chrome = {
    tabs: {
      get: async (tabId) => ({ id: tabId, url: 'https://www.youtube.com', windowId: 7 }),
      query: async () => [],
    },
    scripting: {
      executeScript: async (options) => {
        const source = String(options.func)
        if (source.includes('findInPage')) {
          globalThis.document = fakePage([playlistLink, otherLink])
          const result = options.func(...options.args)
          return [{ result }]
        }
        if (source.includes('matchMedia')) return [{ result: true }]
        return [{ result: null }]
      },
    },
  }

  try {
    const result = await findTool({ name: 'find', text: 'ela' }, { activeTabId: 42 })
    assert.equal(result.matches.length, 1, 'apenas a playlist que contém "ela" deve casar')
    const match = result.matches[0]
    assert.match(match.text, /ela/i, 'o texto visível real deve estar presente')
    assert.equal(match.tag, 'a')
    assert.equal(match.href, 'https://www.youtube.com/playlist?list=WL4E2A1B9')
    assert.ok(
      match.selector && match.selector.includes('playlist?list=WL4E2A1B9'),
      `o seletor deve derivar do elemento REAL: ${match.selector}`,
    )
  } finally {
    globalThis.chrome = originalChrome
    globalThis.document = originalDocument
  }
})

test('G1 find: nonexistent text returns an empty match list (honest no-result)', async () => {
  const originalChrome = globalThis.chrome
  const originalDocument = globalThis.document
  const link = element('a', { href: 'https://www.youtube.com/playlist?list=WL000' }, 'Favoritos antigos')

  globalThis.chrome = {
    tabs: {
      get: async (tabId) => ({ id: tabId, url: 'https://www.youtube.com', windowId: 7 }),
      query: async () => [],
    },
    scripting: {
      executeScript: async (options) => {
        if (String(options.func).includes('findInPage')) {
          globalThis.document = fakePage([link])
          return [{ result: options.func(...options.args) }]
        }
        if (String(options.func).includes('matchMedia')) return [{ result: true }]
        return [{ result: null }]
      },
    },
  }

  try {
    const result = await findTool({ name: 'find', text: 'não existe esta playlist' }, { activeTabId: 42 })
    assert.deepEqual(result.matches, [], 'nenhum match deve ser devolvido para texto ausente')
  } finally {
    globalThis.chrome = originalChrome
    globalThis.document = originalDocument
  }
})

test('G1 find: text is required', async () => {
  const originalChrome = globalThis.chrome
  globalThis.chrome = {
    tabs: { get: async () => ({ id: 1 }), query: async () => [] },
  }
  try {
    await assert.rejects(
      () => findTool({ name: 'find' }, { activeTabId: 42 }),
      /text is required/,
    )
  } finally {
    globalThis.chrome = originalChrome
  }
})
