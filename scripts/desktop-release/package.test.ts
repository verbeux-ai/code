import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assertDesktopIntegrationContract,
  assertRegularPayloadTree,
  materializePayload,
  packageDesktopCli,
} from './package.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'verboo-desktop-package-test-'))
  temporaryRoots.push(root)
  const source = join(root, 'source')
  const output = join(root, 'output')
  await mkdir(join(source, 'dist'), { recursive: true })
  await mkdir(join(source, 'node_modules', 'dependency'), { recursive: true })
  await writeFile(
    join(source, 'dist', 'cli.mjs'),
    "// TodoWrite TodoWrite todoFeatureEnabled todo_reminder todo_reminder\nif (process.argv[2] === 'provider-accounts') console.log(JSON.stringify({ schemaVersion: 1, ok: true, data: { protocols: ['provider_accounts_v1'], secureStorage: { native: true, backend: 'fixture', probe: 'missing' } } })); else if (process.argv[2] === '--internal-protocol-self-test') console.log(JSON.stringify({ schemaVersion: 1, ok: true, marker: 'Verboo: ação, ç, 你好, 👩🏽‍💻, é', checks: ['split_tool_name', 'terminal_tool_prefix', 'unprefixed_mcp_exact_only', 'visible_unicode', 'post_terminal', 'strict_utf8', 'invalid_unicode_scalar'] })); else console.log('1.2.3 (Verboo Code)')\n",
  )
  await writeFile(join(source, 'node_modules', 'dependency', 'index.js'), 'export default 1\n')
  await writeFile(join(source, 'LICENSE'), 'MIT\n')
  return { root, source, output }
}

describe('desktop CLI native packaging', () => {
  test('rejects a built entrypoint that no longer exposes desktop todo markers', () => {
    expect(() => assertDesktopIntegrationContract('TodoWrite todoFeatureEnabled todo_reminder')).toThrow(
      'Desktop integration marker',
    )
    expect(() =>
      assertDesktopIntegrationContract(
        'TodoWrite TodoWrite todoFeatureEnabled todo_reminder todo_reminder',
      ),
    ).not.toThrow()
  })

  test('materializes the entrypoint, dependency tree, metadata, and license without Node', async () => {
    const { root, source } = await fixture()
    const payload = await materializePayload({
      version: '1.2.3',
      target: 'aarch64-apple-darwin',
      entrypoint: join(source, 'dist', 'cli.mjs'),
      nodeModules: join(source, 'node_modules'),
      license: join(source, 'LICENSE'),
      stagingRoot: join(root, 'staging'),
    })

    expect(await readFile(join(payload, 'dist', 'cli.mjs'), 'utf8')).toContain('1.2.3')
    expect(await readFile(join(payload, 'LICENSE'), 'utf8')).toBe('MIT\n')
    expect(await Bun.file(join(payload, 'node')).exists()).toBe(false)
    expect(await Bun.file(join(payload, 'node.exe')).exists()).toBe(false)

    const metadata = JSON.parse(await readFile(join(payload, 'package.json'), 'utf8'))
    expect(metadata).toMatchObject({
      name: '@verboo/code',
      version: '1.2.3',
      type: 'module',
      verbooDesktop: { schemaVersion: 1, target: 'aarch64-apple-darwin' },
    })
  })

  test.skipIf(process.platform === 'win32')('dereferences dependency symlinks', async () => {
    const { root, source } = await fixture()
    await mkdir(join(source, 'node_modules', '.bin'), { recursive: true })
    await symlink(
      join(source, 'node_modules', 'dependency', 'index.js'),
      join(source, 'node_modules', '.bin', 'dependency'),
    )

    const payload = await materializePayload({
      version: '1.2.3',
      target: 'aarch64-apple-darwin',
      entrypoint: join(source, 'dist', 'cli.mjs'),
      nodeModules: join(source, 'node_modules'),
      license: join(source, 'LICENSE'),
      stagingRoot: join(root, 'staging'),
    })

    expect((await stat(join(payload, 'node_modules', '.bin', 'dependency'))).isFile()).toBe(true)
    await expect(assertRegularPayloadTree(payload)).resolves.toBeUndefined()
  })

  test('creates a hashed archive only after the payload smoke passes', async () => {
    const { source, output } = await fixture()
    const result = await packageDesktopCli({
      version: '1.2.3',
      target: 'aarch64-apple-darwin',
      entrypoint: join(source, 'dist', 'cli.mjs'),
      nodeModules: join(source, 'node_modules'),
      license: join(source, 'LICENSE'),
      outputDir: output,
      nodeExecutable: process.execPath,
    })

    expect(result.size).toBeGreaterThan(0)
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(await Bun.file(result.archivePath).exists()).toBe(true)
    expect(JSON.parse(await readFile(result.metadataPath, 'utf8'))).toMatchObject({
      version: '1.2.3',
      target: 'aarch64-apple-darwin',
      size: result.size,
      sha256: result.sha256,
    })
  })

  test('does not leave an archive when the smoke output is for another version', async () => {
    const { source, output } = await fixture()
    await expect(
      packageDesktopCli({
        version: '9.9.9',
        target: 'aarch64-apple-darwin',
        entrypoint: join(source, 'dist', 'cli.mjs'),
        nodeModules: join(source, 'node_modules'),
        license: join(source, 'LICENSE'),
        outputDir: output,
        nodeExecutable: process.execPath,
      }),
    ).rejects.toThrow('CLI smoke version mismatch')
  })
})
