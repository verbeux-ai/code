/**
 * VERBOO-BRAND: the shell completion cache must not live in ~/.claude, where
 * it overwrote Claude Code's own completion files on every `verboo update`.
 * detectShell is private and setupShellCompletion edits the real rc file, so
 * the wiring is asserted structurally.
 */
import { expect, test } from 'bun:test'
import { resolve } from 'path'

const source = () => Bun.file(resolve(import.meta.dir, 'completionCache.ts')).text()

test('completion cache lives in the Verboo config dir', async () => {
  const content = await source()
  expect(content).toContain('const claudeDir = getClaudeConfigHomeDir()')
  expect(content).not.toMatch(/join\(home, '\.claude'\)/)
})

test('a Claude Code completion line in the rc file does not count as ours', async () => {
  const content = await source()
  expect(content).not.toContain("existing.includes('claude completion')")
  expect(content).toContain('# Verboo Code shell completions')
})
