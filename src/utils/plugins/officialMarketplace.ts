/**
 * Constants for marketplaces bundled with Verboo Code.
 *
 * Verboo is the primary native marketplace. The Anthropic marketplace remains
 * available as a native secondary source for the Claude plugins it provides.
 */

import type { MarketplaceSource } from './schemas.js'

export const VERBOO_MARKETPLACE_NAME = 'verboo-plugins'
export const VERBOO_MARKETPLACE_URL =
  'https://code.verboo.ai/api/plugins/marketplace.json'

/** Source configuration for Verboo's primary marketplace. */
export const VERBOO_MARKETPLACE_SOURCE = {
  source: 'url',
  url: VERBOO_MARKETPLACE_URL,
} as const satisfies MarketplaceSource

export const CLAUDE_MARKETPLACE_NAME = 'claude-plugins-official'

/** Source configuration for the native Anthropic secondary marketplace. */
export const CLAUDE_MARKETPLACE_SOURCE = {
  source: 'github',
  repo: 'anthropics/claude-plugins-official',
} as const satisfies MarketplaceSource

export const NATIVE_MARKETPLACES = [
  {
    name: VERBOO_MARKETPLACE_NAME,
    source: VERBOO_MARKETPLACE_SOURCE,
  },
  {
    name: CLAUDE_MARKETPLACE_NAME,
    source: CLAUDE_MARKETPLACE_SOURCE,
  },
] as const

/**
 * Priority used by plugin surfaces. A lower number is displayed first.
 * Unknown third-party marketplaces are intentionally kept after native ones.
 */
export function nativeMarketplacePriority(name: string): number {
  const normalizedName = name.toLowerCase()
  const index = NATIVE_MARKETPLACES.findIndex(
    marketplace => marketplace.name === normalizedName,
  )
  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}

/** @deprecated Use CLAUDE_MARKETPLACE_SOURCE for Anthropic-specific flows. */
export const OFFICIAL_MARKETPLACE_SOURCE = CLAUDE_MARKETPLACE_SOURCE

/** @deprecated Use CLAUDE_MARKETPLACE_NAME for Anthropic-specific flows. */
export const OFFICIAL_MARKETPLACE_NAME = CLAUDE_MARKETPLACE_NAME
