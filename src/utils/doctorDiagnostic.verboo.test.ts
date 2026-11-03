/**
 * VERBOO-BRAND: `verboo doctor` must only look for @verboo/code. A globally
 * installed @anthropic-ai/claude-code is the user's other product and must
 * never be reported as a leftover/orphaned Verboo installation.
 */
import { afterEach, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as realLocalInstaller from './localInstaller.js'

const originalMacro = (globalThis as Record<string, unknown>).MACRO
let prefix: string | undefined

afterEach(() => {
  ;(globalThis as Record<string, unknown>).MACRO = originalMacro
  if (prefix) rmSync(prefix, { recursive: true, force: true })
  prefix = undefined
  mock.restore()
})

async function detectWithGlobalPackages(packages: string[]) {
  prefix = mkdtempSync(join(tmpdir(), 'verboo-doctor-'))
  for (const name of packages) {
    mkdirSync(join(prefix, 'lib', 'node_modules', name), { recursive: true })
  }
  ;(globalThis as Record<string, unknown>).MACRO = { PACKAGE_URL: '@verboo/code' }
  const npmPrefix = prefix
  mock.module('./execFileNoThrow.js', () => ({
    execFileNoThrow: async () => ({ code: 0, stdout: `${npmPrefix}\n`, stderr: '' }),
  }))
  mock.module('./localInstaller.js', () => ({
    ...realLocalInstaller,
    getDetectedLocalInstallDir: async () => null,
  }))
  const { detectMultipleInstallations } = await import(
    `./doctorDiagnostic.ts?ts=${Date.now()}-${Math.random()}`
  )
  const installations = (await detectMultipleInstallations()) as Array<{ type: string; path: string }>
  // Native/local entries depend on the machine running the test; only the npm
  // prefix built above is under test here.
  return installations.filter(installation => installation.type.startsWith('npm-global'))
}

test('an installed Claude Code is not reported as a Verboo installation', async () => {
  const installations = await detectWithGlobalPackages(['@anthropic-ai/claude-code'])
  expect(installations).toEqual([])
})

test('an orphaned @verboo/code package is still reported', async () => {
  const installations = await detectWithGlobalPackages([
    '@anthropic-ai/claude-code',
    '@verboo/code',
  ])
  expect(installations.map(installation => installation.type)).toEqual([
    'npm-global-orphan',
  ])
  expect(installations[0]?.path).toEndWith(join('node_modules', '@verboo', 'code'))
})
