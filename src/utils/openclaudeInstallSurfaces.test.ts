import { afterEach, expect, mock, test } from 'bun:test'
import * as fsPromises from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import * as realEnv from '../utils/env.js'

const originalEnv = { ...process.env }
const originalMacro = (globalThis as Record<string, unknown>).MACRO

afterEach(() => {
  process.env = { ...originalEnv }
  ;(globalThis as Record<string, unknown>).MACRO = originalMacro
  mock.restore()
})

async function importFreshInstallCommand() {
  return import(`../commands/install.tsx?ts=${Date.now()}-${Math.random()}`)
}

async function importFreshInstaller() {
  return import(`./nativeInstaller/installer.ts?ts=${Date.now()}-${Math.random()}`)
}

test('install command displays verboo-code/bin/verboo on non-Windows', async () => {
  mock.module('../utils/env.js', () => ({
    ...realEnv,
    env: { ...realEnv.env, platform: 'darwin' },
  }))

  const { getInstallationPath } = await importFreshInstallCommand()

  expect(getInstallationPath()).toBe('verboo-code/bin/verboo')
})

test('install command displays verboo-code\\bin\\verboo on Windows', async () => {
  mock.module('../utils/env.js', () => ({
    ...realEnv,
    env: { ...realEnv.env, platform: 'win32' },
  }))

  const { getInstallationPath } = await importFreshInstallCommand()

  expect(getInstallationPath()).toBe('verboo-code\\bin\\verboo')
})

// VERBOO-BRAND: there is no native build of @verboo/code. The upstream cleanup
// uninstalled @anthropic-ai/claude-code and @verboo/code and the installer
// downloaded Claude Code from Anthropic's bucket; both must now do nothing.
test('cleanupNpmInstallations never uninstalls or deletes anything', async () => {
  const removedPaths: string[] = []
  const commands: string[][] = []
  ;(globalThis as Record<string, unknown>).MACRO = {
    PACKAGE_URL: '@verboo/code',
  }

  mock.module('fs/promises', () => ({
    ...fsPromises,
    rm: async (path: string) => {
      removedPaths.push(path)
    },
    unlink: async (path: string) => {
      removedPaths.push(path)
    },
  }))

  mock.module('./execFileNoThrow.js', () => ({
    execFileNoThrowWithCwd: async (file: string, args: string[]) => {
      commands.push([file, ...args])
      return { code: 0, stdout: '', stderr: '' }
    },
    execFileNoThrow: async (file: string, args: string[]) => {
      commands.push([file, ...args])
      return { code: 0, stdout: '', stderr: '' }
    },
  }))

  mock.module('./envUtils.js', () => ({
    getClaudeConfigHomeDir: () => join(homedir(), '.verboo'),
    isEnvTruthy: (value: string | undefined) => value === '1',
  }))

  const { cleanupNpmInstallations } = await importFreshInstaller()
  expect(await cleanupNpmInstallations()).toEqual({
    removed: 0,
    errors: [],
    warnings: [],
  })
  expect(removedPaths).toEqual([])
  expect(commands).toEqual([])
})

test('installLatest resolves without downloading anything', async () => {
  let requests = 0
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    requests += 1
    return new Response('')
  }) as unknown as typeof fetch
  mock.module('axios', () => ({
    default: {
      get: async () => {
        requests += 1
        return { data: '' }
      },
    },
  }))
  try {
    const { installLatest } = await importFreshInstaller()
    expect(await installLatest('latest', true)).toEqual({
      latestVersion: null,
      wasUpdated: false,
    })
    expect(requests).toBe(0)
  } finally {
    globalThis.fetch = previousFetch
  }
})
