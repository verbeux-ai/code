/**
 * policy.test.js — Unit tests for the URL-based policy engine (policy.ts).
 *
 * Tests: hard blocks, user allow/deny overrides, sensitive category detection.
 *
 * Run with: node --test src/policy/policy.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkUrl, isHardBlocked } from './policy.js'

// ── Hard blocks ───────────────────────────────────────────────

test('isHardBlocked: chrome:// is blocked', () => {
  assert.equal(isHardBlocked('chrome://settings'), true)
})

test('isHardBlocked: chrome-extension:// is blocked', () => {
  assert.equal(isHardBlocked('chrome-extension://abc123/page.html'), true)
})

test('isHardBlocked: about: is blocked', () => {
  assert.equal(isHardBlocked('about:blank'), true)
})

test('isHardBlocked: Chrome Web Store is blocked', () => {
  assert.equal(isHardBlocked('https://chrome.google.com/webstore/detail/xyz'), true)
})

test('isHardBlocked: regular HTTP is not blocked', () => {
  assert.equal(isHardBlocked('https://example.com'), false)
})

test('checkUrl: hard block returns deny and category', () => {
  const r = checkUrl('chrome://settings')
  assert.equal(r.verdict, 'deny')
  assert.equal(r.matchedRule?.reason, 'internal_chrome_page')
})

// ── Sensitive category detection ──────────────────────────────

test('checkUrl: login page returns confirm', () => {
  const r = checkUrl('https://example.com/login')
  assert.equal(r.verdict, 'confirm')
})

test('checkUrl: checkout page returns confirm', () => {
  const r = checkUrl('https://shop.example/checkout/cart')
  assert.equal(r.verdict, 'confirm')
})

test('checkUrl: general page returns allow', () => {
  const r = checkUrl('https://example.com/about')
  assert.equal(r.verdict, 'allow')
})

// ── User policy overrides ────────────────────────────────────

test('checkUrl: user deny overrides sensitive confirm', () => {
  const r = checkUrl('https://example.com/login', {
    allowlist: [],
    blocklist: [{ pattern: 'example\\.com/login', verdict: 'deny', category: 'credentials', reason: 'no auto' }],
  })
  assert.equal(r.verdict, 'deny')
})

test('checkUrl: user allow overrides sensitive confirm', () => {
  const r = checkUrl('https://example.com/login', {
    allowlist: [{ pattern: 'example\\.com/login', verdict: 'allow', category: 'credentials' }],
    blocklist: [],
  })
  assert.equal(r.verdict, 'allow')
})
