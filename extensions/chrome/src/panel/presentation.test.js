import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  humanizeModelId,
  modelDisplayName,
  safeMarkdownToHtml,
  structuredResultPreview,
} from './presentation.js'
import * as presentation from './presentation.js'

test('modelDisplayName: prefers router presentation metadata', () => {
  assert.equal(
    modelDisplayName({ id: 'provider/model-v2', displayName: 'Model V2 Fast' }),
    'Model V2 Fast',
  )
})

test('modelDisplayName: humanizes unknown IDs without a model allowlist', () => {
  assert.equal(modelDisplayName({ id: 'kimi-k2.7' }), 'Kimi K2.7')
  assert.equal(humanizeModelId('newprovider-27b-flash'), 'Newprovider 27B Flash')
})

test('safeMarkdownToHtml: renders summary emphasis and line breaks', () => {
  assert.equal(
    safeMarkdownToHtml('Pronto! **Juno** está tocando.\n`youtube.com`'),
    'Pronto! <strong>Juno</strong> está tocando.<br><code>youtube.com</code>',
  )
})

test('safeMarkdownToHtml: renders headings and unordered/ordered lists', () => {
  assert.equal(
    safeMarkdownToHtml('## Resumo\n- Primeiro\n- Segundo\n1. Próximo'),
    '<h2>Resumo</h2><br><ul><li>Primeiro</li><li>Segundo</li></ul><br><ol><li>Próximo</li></ol>',
  )
})

test('safeMarkdownToHtml: renders fenced code blocks without exposing delimiters', () => {
  assert.equal(
    safeMarkdownToHtml('Resultado:\n```csv\nNome,Valor\nJuno,42\n```'),
    'Resultado:<br><pre><code>Nome,Valor\nJuno,42</code></pre>',
  )
})

test('safeMarkdownToHtml: escapes model-provided markup before formatting', () => {
  const html = safeMarkdownToHtml('<img src=x onerror=alert(1)> **ok**')
  assert.doesNotMatch(html, /<img/i)
  assert.match(html, /&lt;img/)
  assert.match(html, /<strong>ok<\/strong>/)
})

test('structuredResultPreview: shows a useful bounded preview for structured data', () => {
  assert.equal(
    structuredResultPreview({
      format: 'csv',
      url: 'https://example.com',
      data: 'Nome,Valor\nJuno,42',
    }),
    'CSV · Nome,Valor Juno,42',
  )
})

test('translatedErrorMessage: translates known backend codes and hides unknown codes', () => {
  assert.equal(typeof presentation.translatedErrorMessage, 'function')
  const translate = (key) => ({
    routine_recording_page_unavailable: 'Open a website before recording a workflow.',
    routine_record_failed: 'Could not change workflow recording.',
  })[key] ?? key

  assert.equal(
    presentation.translatedErrorMessage(
      'routine_recording_page_unavailable',
      'routine_record_failed',
      translate,
    ),
    'Open a website before recording a workflow.',
  )
  assert.equal(
    presentation.translatedErrorMessage('internal_backend_code', 'routine_record_failed', translate),
    'Could not change workflow recording.',
  )
})

test('shouldAppendError: suppresses only an identical consecutive error', () => {
  assert.equal(typeof presentation.shouldAppendError, 'function')
  assert.equal(presentation.shouldAppendError('Same error', 'Same error'), false)
  assert.equal(presentation.shouldAppendError('Different error', 'Same error'), true)
  assert.equal(presentation.shouldAppendError('', 'Same error'), true)
})

test('shouldSubmitComposerKey: plain Enter submits', () => {
  assert.equal(presentation.shouldSubmitComposerKey?.({ key: 'Enter' }), true)
})

test('shouldSubmitComposerKey: Shift+Enter inserts a line break', () => {
  assert.equal(
    presentation.shouldSubmitComposerKey?.({ key: 'Enter', shiftKey: true }),
    false,
  )
})

test('shouldSubmitComposerKey: IME composition never submits', () => {
  assert.equal(
    presentation.shouldSubmitComposerKey?.({ key: 'Enter', isComposing: true }),
    false,
  )
})

test('shouldSubmitComposerKey: an already handled slash command never submits', () => {
  assert.equal(
    presentation.shouldSubmitComposerKey?.({ key: 'Enter', defaultPrevented: true }),
    false,
  )
})
