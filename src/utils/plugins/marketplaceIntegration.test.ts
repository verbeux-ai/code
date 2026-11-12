import { join } from 'path'
import { describe, expect, test } from 'bun:test'

/**
 * Full-stack check that a marketplace survives one unparseable plugin entry.
 *
 * The work happens in `marketplaceIntegration.fixture.ts`, in its own Bun
 * process: Bun shares the `mock.module` registry across test files in a single
 * process, and sibling suites in this directory replace `marketplaceManager`
 * with partial mocks. Running the fixture here would silently exercise those
 * stubs, so the fixture is spawned instead and every assertion stays in this
 * file.
 */
const fixturePath = join(import.meta.dir, 'marketplaceIntegration.fixture.ts')
const RESULT_MARKER = '__MARKETPLACE_FIXTURE__'

type FixtureResult = Record<string, unknown>

let cached: FixtureResult[] | null = null

function runFixture(): FixtureResult[] {
  if (cached) {
    return cached
  }

  const child = Bun.spawnSync({
    cmd: [process.execPath, 'run', fixturePath],
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
    env: {
      ...process.env,
      // The fixture redirects these itself; clearing them keeps a developer's
      // real plugin state out of reach even if that code changes.
      VERBOO_CONFIG_DIR: undefined,
      CLAUDE_CODE_PLUGIN_CACHE_DIR: undefined,
      CLAUDE_CODE_PLUGIN_SEED_DIR: undefined,
      CLAUDE_CODE_USE_COWORK_PLUGINS: undefined,
      // The url scenario talks to a loopback server; don't let an inherited
      // proxy send that request elsewhere.
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
  })

  const stdout = child.stdout.toString()
  const stderr = child.stderr.toString()
  const line = stdout
    .split('\n')
    .reverse()
    .find(candidate => candidate.startsWith(RESULT_MARKER))

  if (child.exitCode !== 0 || !line) {
    throw new Error(
      `marketplace fixture failed (exit ${child.exitCode})\n` +
        `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    )
  }

  cached = JSON.parse(line.slice(RESULT_MARKER.length)) as FixtureResult[]
  return cached
}

function scenario(name: string): FixtureResult {
  const result = runFixture().find(entry => entry.scenario === name)
  if (!result) {
    throw new Error(`fixture produced no "${name}" scenario`)
  }
  expect(result.error).toBeUndefined()
  return result
}

describe('marketplace loading with an unparseable entry', () => {
  test('keeps the rest of a directory catalog', () => {
    const result = scenario('directory')

    expect(result.addedName).toBe('directory-marketplace')
    expect(result.entryCount).toBe(3)
    expect(result.resolved).toEqual([
      ['superpowers', true],
      ['frontend-design', true],
      ['gopls-lsp', true],
    ])
  })

  test('records what it dropped, and why', () => {
    const result = scenario('directory')

    // Assert on the failing field, not the exact Zod message: the message text
    // is Zod's, the field is ours.
    expect(result.skipped).toEqual([
      { name: 'xcode', reason: expect.stringMatching(/^source: /) },
    ])
  })

  test('applies the same tolerance to url sources', () => {
    const result = scenario('url')

    expect(result.entryCount).toBe(1)
    expect(result.skipped).toEqual(['xcode'])
  })

  test('caches the manifest as published, so a cache read still sees the drop', () => {
    const result = scenario('url')

    expect(result.cacheStillHasUnknownEntry).toBe(true)
    expect(result.skippedAfterCacheRead).toEqual(['xcode'])
  })

  test('still fails loudly when the manifest is not a marketplace', () => {
    const result = scenario('broken')

    expect(result.rejected).toBe(true)
    expect(result.message).toContain('Failed to parse marketplace file')
  })
})

describe('delisting enforcement with an unparseable entry', () => {
  test('only removes plugins the marketplace actually delisted', () => {
    const result = scenario('delisting')

    expect(result.skippedSeenByEnforcement).toEqual(['xcode'])
    expect(result.flagged).toEqual(['gone@removing-marketplace'])
    expect(result.installedAfter).toEqual([
      'superpowers@guarded-marketplace',
      'superpowers@passive-marketplace',
      'superpowers@removing-marketplace',
      'xcode@guarded-marketplace',
    ])
  })
})

describe('marketplace loading warnings', () => {
  test('surfaces a skipped entry that costs the user a plugin', () => {
    const result = scenario('formatting')

    expect(result.onlySkipped).toEqual({
      type: 'warning',
      message:
        "Warning: Skipped 1 unreadable plugin entry in marketplace 'claude-plugins-official': xcode",
    })
  })

  test('stays silent when the skipped entry is not an installed plugin', () => {
    expect(scenario('formatting').skippedNotInstalled).toBeNull()
  })

  test('keeps the load failure and the actionable skip in one warning', () => {
    const result = scenario('formatting')

    expect(result.skippedWithFailure).toEqual({
      type: 'warning',
      message:
        "Warning: Failed to load marketplace 'other-marketplace': boom. " +
        "Warning: Skipped 1 unreadable plugin entry in marketplace 'claude-plugins-official': xcode",
    })
  })

  test('stays silent when nothing was skipped', () => {
    expect(scenario('formatting').clean).toBeNull()
  })

  test('a total load failure is still an error', () => {
    expect(scenario('formatting').allFailed).toEqual({
      type: 'error',
      message:
        'Failed to load all marketplaces. Errors: other-marketplace: boom',
    })
  })
})

describe('observability of a skipped entry', () => {
  test('reaches the load path that feeds /plugin', () => {
    const result = scenario('graceful')

    expect(result.skippedEntries).toEqual([
      { name: 'guarded-marketplace', entries: ['xcode'] },
    ])
  })

  test('lands in the error log, not only in --debug output', () => {
    expect(scenario('graceful').errorLogMentionsSkip).toBe(true)
  })
})
