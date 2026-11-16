import { existsSync, readFileSync } from 'node:fs'

// The SDK bundle ships too when present; both must stay free of these.
export const BUNDLES = ['dist/cli.mjs', 'dist/sdk.mjs'] as const

export const BANNED_PATTERNS = [
  'datadoghq.com',
  'api/event_logging/batch',
  'api/claude_code/metrics',
  'getKubernetesNamespace',
  '/var/run/secrets/kubernetes',
  '/proc/self/mountinfo',
  'tengu_internal_record_permission_context',
  'anthropic-serve',
  'infra.ant.dev',
  'claude-code-feedback',
  'C07VBSHV7EV',
] as const

export function findBannedPatterns(
  contents: string,
  patterns: readonly string[] = BANNED_PATTERNS,
): Array<{ pattern: string; count: number }> {
  return patterns
    .map(pattern => ({ pattern, count: contents.split(pattern).length - 1 }))
    .filter(result => result.count > 0)
}

function main(): number {
  if (!existsSync(BUNDLES[0])) {
    console.error(`ERROR: ${BUNDLES[0]} not found. Run 'bun run build' first.`)
    return 1
  }

  let exitCode = 0
  for (const bundle of BUNDLES) {
    if (!existsSync(bundle)) continue
    const found = findBannedPatterns(readFileSync(bundle, 'utf8'))
    console.log(`Checking ${bundle} for banned patterns...`)
    for (const { pattern, count } of found) {
      console.log(`  FAIL: '${pattern}' found (${count} occurrences)`)
      exitCode = 1
    }
    if (found.length === 0) console.log(`  PASS: none of ${BANNED_PATTERNS.length} patterns found`)
  }

  console.log('')
  console.log(
    exitCode === 0
      ? '✓ All checks passed — no banned patterns in build output'
      : '✗ FAILED — banned patterns found in build output',
  )
  return exitCode
}

if (import.meta.main) process.exit(main())
