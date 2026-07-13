import { describe, expect, test } from 'bun:test'
import {
  CLAUDE_MARKETPLACE_NAME,
  nativeMarketplacePriority,
  VERBOO_MARKETPLACE_NAME,
  VERBOO_MARKETPLACE_URL,
} from './officialMarketplace.js'
import {
  isMarketplaceAutoUpdate,
  validateOfficialNameSource,
} from './schemas.js'

describe('native marketplace sources', () => {
  test('accepts only Verboo canonical URL for the reserved Verboo name', () => {
    expect(
      validateOfficialNameSource(VERBOO_MARKETPLACE_NAME, {
        source: 'url',
        url: VERBOO_MARKETPLACE_URL,
      }),
    ).toBeNull()

    expect(
      validateOfficialNameSource(VERBOO_MARKETPLACE_NAME, {
        source: 'url',
        url: 'https://example.com/marketplace.json',
      }),
    ).toContain('reserved for the Verboo marketplace')
  })

  test('continues to require an Anthropic source for the Claude marketplace', () => {
    expect(
      validateOfficialNameSource(CLAUDE_MARKETPLACE_NAME, {
        source: 'github',
        repo: 'anthropics/claude-plugins-official',
      }),
    ).toBeNull()

    expect(
      validateOfficialNameSource(CLAUDE_MARKETPLACE_NAME, {
        source: 'url',
        url: VERBOO_MARKETPLACE_URL,
      }),
    ).toContain('official Anthropic marketplaces')
  })

  test('prioritizes Verboo before the Claude marketplace', () => {
    expect(nativeMarketplacePriority(VERBOO_MARKETPLACE_NAME)).toBeLessThan(
      nativeMarketplacePriority(CLAUDE_MARKETPLACE_NAME),
    )
    expect(nativeMarketplacePriority('community-plugins')).toBe(
      Number.MAX_SAFE_INTEGER,
    )
  })

  test('enables automatic updates for the Verboo marketplace by default', () => {
    expect(isMarketplaceAutoUpdate(VERBOO_MARKETPLACE_NAME, {})).toBe(true)
  })
})
