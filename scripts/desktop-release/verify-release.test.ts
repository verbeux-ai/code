import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DESKTOP_TARGETS, manifestBytes } from './contract.js'
import { packageDesktopCli } from './package.js'
import { buildManifestFromAssets } from './manifest.js'
import { verifyReleaseSet } from './verify-release.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function releaseFixture() {
  const root = await mkdtemp(join(tmpdir(), 'verboo-release-set-test-'))
  roots.push(root)
  const source = join(root, 'source')
  const assetsDir = join(root, 'assets')
  const publicKeyText = 'fixture-public-key\n'
  const signingKeyId = createHash('sha256')
    .update(publicKeyText.trim(), 'utf8')
    .digest('hex')
    .slice(0, 16)
  await mkdir(join(source, 'dist'), { recursive: true })
  await mkdir(join(source, 'node_modules', 'dependency'), { recursive: true })
  await writeFile(
    join(source, 'dist', 'cli.mjs'),
    "// TodoWrite TodoWrite todoFeatureEnabled todo_reminder todo_reminder\nconsole.log('1.2.3 (Verboo Code)')\n",
  )
  await writeFile(join(source, 'node_modules', 'dependency', 'index.js'), 'export default 1\n')
  await writeFile(join(source, 'LICENSE'), 'MIT\n')

  for (const { target } of DESKTOP_TARGETS) {
    await packageDesktopCli({
      version: '1.2.3',
      target,
      entrypoint: join(source, 'dist', 'cli.mjs'),
      nodeModules: join(source, 'node_modules'),
      license: join(source, 'LICENSE'),
      outputDir: assetsDir,
      nodeExecutable: process.execPath,
    })
  }
  const manifest = await buildManifestFromAssets({
    assetsDir,
    repository: 'verbeux-ai/code',
    tag: 'v1.2.3',
    version: '1.2.3',
    releasedAt: '2026-08-08T12:00:00.000Z',
    signingKeyId,
  })
  const manifestPath = join(assetsDir, 'verboo-cli-manifest.json')
  const signaturePath = join(assetsDir, 'verboo-cli-manifest.minisig')
  const publicKeyPath = join(assetsDir, 'test.pub')
  await writeFile(manifestPath, manifestBytes(manifest))
  await writeFile(signaturePath, 'fixture-signature\n')
  await writeFile(publicKeyPath, publicKeyText)
  return { assetsDir, manifestPath, signaturePath, publicKeyPath, manifest }
}

describe('desktop CLI release verification', () => {
  test('verifies the signature before parsing or trusting the manifest', async () => {
    const fixture = await releaseFixture()
    await writeFile(fixture.manifestPath, '{not-json')
    let called = false
    await expect(
      verifyReleaseSet({
        ...fixture,
        verifySignature: async () => {
          called = true
          throw new Error('signature rejected')
        },
      }),
    ).rejects.toThrow('signature rejected')
    expect(called).toBe(true)
  })

  test('accepts a complete unchanged release set', async () => {
    const fixture = await releaseFixture()
    await expect(
      verifyReleaseSet({ ...fixture, verifySignature: async () => {} }),
    ).resolves.toMatchObject({ cliVersion: '1.2.3' })
  })

  test('rejects one changed archive byte after signature verification', async () => {
    const fixture = await releaseFixture()
    const archive = fixture.manifest.artifacts[0]
    const archivePath = join(fixture.assetsDir, archive.url.split('/').at(-1)!)
    const bytes = new Uint8Array(await Bun.file(archivePath).arrayBuffer())
    bytes[0] ^= 1
    await writeFile(archivePath, bytes)

    await expect(
      verifyReleaseSet({ ...fixture, verifySignature: async () => {} }),
    ).rejects.toThrow(/mismatch/)
  })

  test('rejects a manifest whose signed target set is incomplete', async () => {
    const fixture = await releaseFixture()
    fixture.manifest.artifacts.pop()
    await writeFile(fixture.manifestPath, manifestBytes(fixture.manifest))
    await expect(
      verifyReleaseSet({ ...fixture, verifySignature: async () => {} }),
    ).rejects.toThrow('exactly one artifact')
  })
})
