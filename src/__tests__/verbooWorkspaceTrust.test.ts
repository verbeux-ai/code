/**
 * Workspace trust in Verboo mode.
 *
 * showSetupScreens cannot be imported under bun test (its import chain trips
 * the compile-time feature() macro checker), so the wiring is asserted
 * structurally here and behaviorally in setupScreenGates.test.ts and the PTY
 * e2e suite (scripts/e2e/cli.e2e.mjs).
 */

import { describe, expect, test } from 'bun:test'
import { resolve } from 'path'

const SRC = resolve(import.meta.dir, '..')
const file = (relative: string) => Bun.file(resolve(SRC, relative))

describe('workspace trust prompt in Verboo mode', () => {
  test('the trust dialog is gated by getRequiredSetupScreens, not by the provider', async () => {
    const content = await file('interactiveHelpers.tsx').text()
    expect(content).toContain('if (setupScreens.trustDialog)')
    expect(content).not.toMatch(/usesAnthropicSetup\s*&&\s*!checkHasTrustDialogAccepted\(\)/)
  })

  test('auth runs first, then the dialog, and only then trust is marked and env applied', async () => {
    const content = await file('interactiveHelpers.tsx').text()
    const auth = content.indexOf('await ensureVerbooAuthenticated()')
    const dialog = content.indexOf("await import('./components/TrustDialog/TrustDialog.js')")
    const markTrusted = content.indexOf('setSessionTrustAccepted(true)')
    const applyEnv = content.indexOf('applyConfigEnvironmentVariables()')
    expect(auth).toBeGreaterThan(-1)
    expect(dialog).toBeGreaterThan(auth)
    expect(markTrusted).toBeGreaterThan(dialog)
    expect(applyEnv).toBeGreaterThan(markTrusted)
  })

  test('declining the dialog exits instead of returning to setup', async () => {
    const content = await file('components/TrustDialog/TrustDialog.tsx').text()
    expect(content).toMatch(/value === "exit"\)\s*{\s*gracefulShutdownSync\(1\)/)
  })

  test('the dialog no longer links to the Claude Code security guide', async () => {
    const content = await file('components/TrustDialog/TrustDialog.tsx').text()
    expect(content).not.toContain('code.claude.com')
  })
})
