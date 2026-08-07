import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractPageContent } from './extractPageContent.js'

/**
 * G3-CHROME: full-page extraction must deliver the ENTIRE text of a long
 * page. The handler itself must never truncate — chunking (if any) happens
 * in the agent loop, not here.
 */

test('G3 extract_page_content: returns the FULL text of a long page (no truncation)', async () => {
  const originalChrome = globalThis.chrome
  // ~50k chars — well beyond the 4000-char agent result limit.
  const longText = `INICIO-DA-PAGINA ${'conteudo intermediario. '.repeat(8000)} FIM-DA-PAGINA-MARCADOR-UNICO`

  globalThis.chrome = {
    tabs: {
      get: async (tabId) => ({ id: tabId, url: 'https://long-blog.example/post', windowId: 7 }),
      query: async () => [],
    },
    scripting: {
      executeScript: async (options) => {
        const source = String(options.func)
        if (source.includes('extractInPage')) {
          return [{ result: options.func(...options.args) }]
        }
        if (source.includes('matchMedia')) return [{ result: true }]
        return [{ result: null }]
      },
    },
  }
  globalThis.document = {
    body: { innerText: longText, textContent: longText },
    querySelector: () => null,
  }

  try {
    const result = await extractPageContent({ name: 'extract_page_content' }, { activeTabId: 42 })
    assert.ok(
      result.text.length > 40_000,
      `o handler deve devolver a página inteira (${result.text.length} chars)`,
    )
    assert.ok(
      result.text.includes('FIM-DA-PAGINA-MARCADOR-UNICO'),
      'o fim da página deve estar presente no texto devolvido',
    )
    assert.ok(result.text.includes('INICIO-DA-PAGINA'))
  } finally {
    globalThis.chrome = originalChrome
    globalThis.document = undefined
  }
})
