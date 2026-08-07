/**
 * planMessage.test.js — unit tests for the agent planner heuristic.
 *
 * Run with: node --test src/planMessage.test.js
 *
 * Pure-function tests — no chrome.* shim required.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  planForMessage,
  extractUrl,
  matchSiteToken,
  isControllableUrl,
  nonControllablePageMessage,
  extractYoutubeSearchQuery,
} from './planMessage.js'

// ── isControllableUrl ───────────────────────────────────────

test('isControllableUrl: accepts https and http', () => {
  assert.equal(isControllableUrl('https://example.com'), true)
  assert.equal(isControllableUrl('http://example.com/path'), true)
  assert.equal(isControllableUrl('HTTPS://Example.Com'), true) // case-insensitive
})

test('isControllableUrl: rejects chrome / about / edge / file', () => {
  assert.equal(isControllableUrl('chrome://extensions'), false)
  assert.equal(isControllableUrl('chrome-extension://abcdef/options.html'), false)
  assert.equal(isControllableUrl('about:blank'), false)
  assert.equal(isControllableUrl('edge://settings'), false)
  assert.equal(isControllableUrl('file:///Users/x/index.html'), false)
  assert.equal(isControllableUrl('view-source:https://example.com'), false)
})

test('isControllableUrl: rejects empty / null / undefined / ftp', () => {
  assert.equal(isControllableUrl(''), false)
  assert.equal(isControllableUrl(null), false)
  assert.equal(isControllableUrl(undefined), false)
  assert.equal(isControllableUrl('ftp://example.com'), false)
})

// ── extractUrl ──────────────────────────────────────────────

test('extractUrl: returns first http(s) match', () => {
  assert.equal(extractUrl('open https://example.com for me'), 'https://example.com')
  assert.equal(extractUrl('go to http://foo.bar/path?x=1'), 'http://foo.bar/path?x=1')
})

test('extractUrl: falls back to a known site token', () => {
  assert.equal(extractUrl('open youtube for me'), 'https://www.youtube.com')
  assert.equal(extractUrl('go to github'), 'https://github.com')
  assert.equal(extractUrl('abra o gmail'), 'https://mail.google.com')
})

test('extractUrl: does NOT invent an arbitrary domain', () => {
  assert.equal(extractUrl('open myblog'), null)
  assert.equal(extractUrl('go to the thing'), null)
})

test('extractUrl: returns null for empty / non-string input', () => {
  assert.equal(extractUrl(''), null)
  assert.equal(extractUrl(null), null)
  assert.equal(extractUrl(undefined), null)
  assert.equal(extractUrl(42), null)
})

// ── matchSiteToken ──────────────────────────────────────────

test('matchSiteToken: returns canonical URL for first hit', () => {
  assert.equal(matchSiteToken('search youtube for cats'), 'https://www.youtube.com')
  assert.equal(matchSiteToken('check my github'), 'https://github.com')
  assert.equal(matchSiteToken('open x.com'), 'https://x.com')
})

test('matchSiteToken: prefers multi-word tokens over single-word', () => {
  const result = matchSiteToken('look at stack overflow')
  assert.equal(result, 'https://stackoverflow.com')
})

test('matchSiteToken: returns null when nothing matches', () => {
  assert.equal(matchSiteToken('hello world'), null)
})

// ── planForMessage — navigate intent (EN + PT) ──────────────

test('planForMessage: EN "open <url>" produces a navigate', () => {
  const r = planForMessage('open https://example.com', 'https://example.com')
  assert.equal(r.assistantMessage, undefined)
  assert.equal(r.plan.length, 1)
  assert.equal(r.plan[0].name, 'navigate')
  assert.equal(r.plan[0].url, 'https://example.com')
  assert.equal(r.plan[0].params.url, 'https://example.com') // back-compat
  assert.equal(r.plan[0].risk, 'mutate')
})

test('planForMessage: PT "abra o youtube" navigates from chrome:// page', () => {
  // The exact bug from the owner video: "abra o youtube para mim" on
  // chrome://extensions. Planner must NOT fall back to read_page.
  const r = planForMessage('abra o youtube para mim', 'chrome://extensions')
  assert.equal(r.assistantMessage, undefined)
  assert.equal(r.plan.length, 1)
  assert.equal(r.plan[0].name, 'navigate')
  assert.equal(r.plan[0].url, 'https://www.youtube.com')
})

test('planForMessage: EN "go to <site>" with site token', () => {
  const r = planForMessage('go to github', 'https://example.com')
  assert.equal(r.assistantMessage, undefined)
  assert.equal(r.plan.length, 1)
  assert.equal(r.plan[0].name, 'navigate')
  assert.equal(r.plan[0].url, 'https://github.com')
})

test('planForMessage: PT intent verbs (abrir, abre, ir para, acessar)', () => {
  const cases = [
    ['abrir gmail', 'https://mail.google.com'],
    ['abre o twitter', 'https://x.com'],
    ['vai para o google', 'https://www.google.com'],
    ['ir para reddit', 'https://www.reddit.com'],
    ['acessar wikipedia', 'https://www.wikipedia.org'],
    ['acesso chatgpt', 'https://chatgpt.com'],
  ]
  for (const [msg, expected] of cases) {
    const r = planForMessage(msg, 'chrome://extensions')
    assert.equal(r.plan.length, 1, `expected 1 tool for "${msg}"`)
    assert.equal(r.plan[0].name, 'navigate', `expected navigate for "${msg}"`)
    assert.equal(r.plan[0].url, expected, `expected ${expected} for "${msg}"`)
  }
})

test('planForMessage: navigate intent without site/URL returns empty + friendly hint', () => {
  const r = planForMessage('open myblog', 'chrome://extensions')
  assert.equal(r.plan.length, 0)
  assert.ok(r.assistantMessage)
  assert.match(r.assistantMessage, /name or URL/i)
})

// ── planForMessage — internal-page fallback ─────────────────

test('planForMessage: internal page + no intent returns friendly error', () => {
  const r = planForMessage('read this for me', 'chrome://extensions')
  assert.equal(r.plan.length, 0)
  assert.ok(r.assistantMessage)
  assert.match(r.assistantMessage, /cannot be controlled/i)
})

test('planForMessage: internal page + navigate intent falls through to navigate', () => {
  const r = planForMessage('abra o youtube', 'chrome://extensions')
  assert.equal(r.assistantMessage, undefined)
  assert.equal(r.plan.length, 1)
  assert.equal(r.plan[0].name, 'navigate')
})

test('planForMessage: about:blank also blocks read_page fallback', () => {
  const r = planForMessage('summarise this page', 'about:blank')
  assert.equal(r.plan.length, 0)
  assert.ok(r.assistantMessage)
  assert.match(r.assistantMessage, /cannot be controlled/i)
})

test('planForMessage: edge:// also blocks read_page fallback', () => {
  const r = planForMessage('summarise this page', 'edge://settings')
  assert.equal(r.plan.length, 0)
  assert.ok(r.assistantMessage)
})

// ── planForMessage — purchase / read fallback ───────────────

test('planForMessage: "buy" produces a click on buy-now (Hard Block target)', () => {
  const r = planForMessage('buy me a laptop', 'https://example.com')
  assert.equal(r.plan.length, 1)
  assert.equal(r.plan[0].name, 'click')
  assert.equal(r.plan[0].params.selector, 'button#buy-now')
})

test('planForMessage: unknown request on controllable page falls back to read_page', () => {
  const r = planForMessage('what does this page say?', 'https://example.com')
  assert.equal(r.plan.length, 1)
  assert.equal(r.plan[0].name, 'read_page')
})

test('planForMessage: empty message returns empty plan + assistant message', () => {
  const r = planForMessage('', 'https://example.com')
  assert.equal(r.plan.length, 0)
  assert.ok(r.assistantMessage)
})

test('planForMessage: handles missing/undefined active tab URL safely', () => {
  const r = planForMessage('what does this say?', undefined)
  assert.equal(r.plan.length, 0)
  assert.ok(r.assistantMessage)
})

// ── YouTube / music search ──────────────────────────────────

test('extractYoutubeSearchQuery: EN search on youtube', () => {
  assert.equal(extractYoutubeSearchQuery('search cats on youtube'), 'cats')
  assert.equal(extractYoutubeSearchQuery('search youtube for lo-fi beats'), 'lo-fi beats')
})

test('extractYoutubeSearchQuery: PT pesquise / tocar musica', () => {
  assert.equal(extractYoutubeSearchQuery('pesquise gatos no youtube'), 'gatos')
  assert.equal(extractYoutubeSearchQuery('tocar musica lo-fi'), 'lo-fi')
  assert.equal(extractYoutubeSearchQuery('tocar música jazz suave'), 'jazz suave')
})

test('extractYoutubeSearchQuery: free-form PT "coloque uma musica da …"', () => {
  assert.equal(
    extractYoutubeSearchQuery('coloque uma musica da sabrina carpenter, house tour'),
    'sabrina carpenter house tour',
  )
})

test('extractYoutubeSearchQuery: strips abra/e so query is not "abra e juno…"', () => {
  const q = extractYoutubeSearchQuery(
    'abra o youtube, e coloque a musica juno da sabrina carpenter',
  )
  assert.ok(q, 'expected a query')
  assert.ok(!/\babra\b/i.test(q), `should not keep abra, got: ${q}`)
  assert.ok(/\bjuno\b/i.test(q), `expected juno in: ${q}`)
  assert.ok(/sabrina/i.test(q), `expected sabrina in: ${q}`)
})

test('extractYoutubeSearchQuery: strips ela/para from birds of feather phrase', () => {
  const q = extractYoutubeSearchQuery(
    'abra o youtube e coloque a musica birds of feather da billie eilish e coloque ela para tocar',
  )
  assert.ok(q)
  assert.ok(!/\bela\b/i.test(q), `got: ${q}`)
  assert.ok(!/\bpara\b/i.test(q), `got: ${q}`)
  assert.match(q, /birds of feather/i)
  assert.match(q, /billie/i)
})

test('extractYoutubeSearchQuery: "coloque a musica para tocar" is not a weak query "para"', () => {
  assert.equal(extractYoutubeSearchQuery('coloque a musica para tocar'), null)
})

test('planForMessage: already on matching YouTube results → click first video only', () => {
  const r = planForMessage(
    'coloque a musica juno da sabrina carpenter',
    'https://www.youtube.com/results?search_query=juno+sabrina+carpenter',
  )
  assert.equal(r.plan.length, 1)
  assert.equal(r.plan[0].name, 'click')
  assert.match(String(r.plan[0].selector || r.plan[0].params?.selector), /video-title/)
})

test('planForMessage: already on /watch → no re-search, friendly message', () => {
  const r = planForMessage(
    'abra o youtube e coloque juno sabrina',
    'https://www.youtube.com/watch?v=abc123',
  )
  assert.equal(r.plan.length, 0)
  assert.ok(r.assistantMessage)
})

test('planForMessage: play intent with no title on results → click first', () => {
  const r = planForMessage(
    'coloque a musica para tocar',
    'https://www.youtube.com/results?search_query=manchild+sabrina+carpenter',
  )
  assert.equal(r.plan.length, 1)
  assert.equal(r.plan[0].name, 'click')
})

test('extractYoutubeSearchQuery: free-form EN play / put on', () => {
  assert.equal(extractYoutubeSearchQuery('play stay kid laroi'), 'stay kid laroi')
  assert.equal(extractYoutubeSearchQuery('play me espresso sabrina carpenter'), 'espresso sabrina carpenter')
  assert.equal(extractYoutubeSearchQuery('put on music lo-fi hip hop'), 'lo-fi hip hop')
})

test('extractYoutubeSearchQuery: toque / song / video clipe', () => {
  assert.equal(extractYoutubeSearchQuery('toque song bad guy billie'), 'bad guy billie')
  assert.equal(extractYoutubeSearchQuery('coloque o video clipe de shape of you'), 'shape of you')
})

test('extractYoutubeSearchQuery: returns null for plain open youtube', () => {
  assert.equal(extractYoutubeSearchQuery('open youtube'), null)
  assert.equal(extractYoutubeSearchQuery('abra o youtube'), null)
})

test('extractYoutubeSearchQuery: returns null without music/youtube intent', () => {
  assert.equal(extractYoutubeSearchQuery('what does this page say?'), null)
  assert.equal(extractYoutubeSearchQuery('hello world'), null)
})

function assertYoutubeResultsNavigate(r, expectedQuery) {
  assert.equal(r.assistantMessage, undefined)
  // navigate + click first result (play intent)
  assert.ok(r.plan.length >= 2, `expected navigate+click, got ${r.plan.length}`)
  assert.equal(r.plan[0].name, 'navigate')
  const expectedUrl =
    'https://www.youtube.com/results?search_query=' +
    encodeURIComponent(expectedQuery)
  assert.equal(r.plan[0].url, expectedUrl)
  assert.equal(r.plan[0].params.url, expectedUrl)
  assert.equal(r.plan[1].name, 'click')
}

test('planForMessage: "search X on youtube" navigates to results URL', () => {
  const r = planForMessage('search cats on youtube', 'chrome://extensions')
  assertYoutubeResultsNavigate(r, 'cats')
})

test('planForMessage: "tocar musica X" navigates to results URL', () => {
  const r = planForMessage('tocar musica lo-fi', 'https://example.com')
  assertYoutubeResultsNavigate(r, 'lo-fi')
})

test('planForMessage: PT music request "coloque uma musica da sabrina carpenter, house tour"', () => {
  const r = planForMessage(
    'coloque uma musica da sabrina carpenter, house tour',
    'chrome://extensions',
  )
  assertYoutubeResultsNavigate(r, 'sabrina carpenter house tour')
})

test('planForMessage: "play stay kid laroi" navigates to results URL', () => {
  const r = planForMessage('play stay kid laroi', 'https://example.com')
  assertYoutubeResultsNavigate(r, 'stay kid laroi')
})

// ── nonControllablePageMessage ──────────────────────────────

test('nonControllablePageMessage: surfaces scheme name', () => {
  const msg = nonControllablePageMessage('chrome://extensions')
  assert.match(msg, /chrome:\/\//)
  assert.match(msg, /Open a normal website/)
})

test('nonControllablePageMessage: works without URL', () => {
  const msg = nonControllablePageMessage(undefined)
  assert.match(msg, /cannot be controlled/i)
})