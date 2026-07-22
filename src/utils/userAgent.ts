/**
 * User-Agent string helpers.
 *
 * Kept dependency-free so SDK-bundled code (bridge, cli/transports) can
 * import without pulling in auth.ts and its transitive dependency tree.
 */

export function getClaudeCodeUserAgent(): string {
  return `claude-code/${MACRO.VERSION}`
}

// Stable product identifier for calls made to Verboo infrastructure. Keep it
// minimal: platform details are not needed for the router client metrics.
export function getVerbooCodeUserAgent(): string {
  const version =
    typeof VERBOO_CODE_BUILD_VERSION !== 'undefined' &&
    VERBOO_CODE_BUILD_VERSION
      ? VERBOO_CODE_BUILD_VERSION
      : 'unknown'
  return `verboo-code/${version}`
}
