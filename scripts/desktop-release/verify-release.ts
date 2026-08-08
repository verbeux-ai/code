import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

import {
  artifactName,
  releaseAssetUrl,
  signingKeyId,
  type DesktopCliManifest,
} from './contract.js'
import { buildManifest } from './manifest.js'

export type VerifyReleaseSetInput = {
  assetsDir: string
  manifestPath: string
  signaturePath: string
  publicKeyPath: string
  verifySignature?: (
    manifestPath: string,
    signaturePath: string,
    publicKeyPath: string,
  ) => Promise<void>
}

export async function verifyReleaseSet(
  input: VerifyReleaseSetInput,
): Promise<DesktopCliManifest> {
  const verifySignature = input.verifySignature ?? verifyWithMinisign
  await verifySignature(input.manifestPath, input.signaturePath, input.publicKeyPath)

  const manifest = JSON.parse(
    await readFile(input.manifestPath, 'utf8'),
  ) as DesktopCliManifest
  validateAuthenticatedManifest(manifest)
  const publicKeyText = await readFile(input.publicKeyPath, 'utf8')
  if (manifest.signingKeyId !== signingKeyId(publicKeyText)) {
    throw new Error('Manifest signing key ID does not match the verification key')
  }

  for (const artifact of manifest.artifacts) {
    const expectedName = artifactName(manifest.cliVersion, artifact.target)
    const expectedUrl = releaseAssetUrl(
      'verbeux-ai/code',
      `v${manifest.cliVersion}`,
      expectedName,
    )
    if (artifact.url !== expectedUrl) {
      throw new Error(`Unexpected release URL for ${artifact.target}`)
    }
    const archivePath = join(input.assetsDir, basename(new URL(artifact.url).pathname))
    const actual = await hashFile(archivePath)
    if (actual.size !== artifact.size) {
      throw new Error(`Size mismatch for ${artifact.target}`)
    }
    if (actual.sha256 !== artifact.sha256) {
      throw new Error(`SHA-256 mismatch for ${artifact.target}`)
    }
    await inspectArchive(archivePath, manifest.cliVersion, artifact.target)
  }
  return manifest
}

function validateAuthenticatedManifest(manifest: DesktopCliManifest): void {
  if (!manifest || typeof manifest !== 'object') throw new Error('Manifest must be an object')
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported manifest schema')
  const expected = buildManifest({
    version: manifest.cliVersion,
    releasedAt: manifest.releasedAt,
    signingKeyId: manifest.signingKeyId,
    artifacts: manifest.artifacts,
  })
  if (
    manifest.desktopProtocol !== expected.desktopProtocol ||
    manifest.desktopVersion?.min !== expected.desktopVersion.min ||
    manifest.desktopVersion?.maxExclusive !== expected.desktopVersion.maxExclusive ||
    manifest.node?.range !== expected.node.range ||
    manifest.node?.modules !== expected.node.modules ||
    manifest.node?.napi !== expected.node.napi
  ) {
    throw new Error('Manifest compatibility contract is invalid')
  }
}

async function inspectArchive(
  archivePath: string,
  version: string,
  target: string,
): Promise<void> {
  const listing = await runProcess('tar', ['-tzf', archivePath])
  const names = listing.stdout.split(/\r?\n/).filter(Boolean)
  if (!names.includes('package.json')) throw new Error(`Archive lacks package.json for ${target}`)
  if (!names.includes('dist/cli.mjs')) throw new Error(`Archive lacks dist/cli.mjs for ${target}`)
  if (!names.some(name => name.startsWith('node_modules/'))) {
    throw new Error(`Archive lacks node_modules for ${target}`)
  }
  for (const name of names) {
    const normalized = name.replace(/\\/g, '/')
    if (
      normalized.startsWith('/') ||
      /^[A-Za-z]:\//.test(normalized) ||
      normalized.split('/').includes('..')
    ) {
      throw new Error(`Unsafe archive path for ${target}: ${name}`)
    }
    if (['node', 'node.exe', 'npm', 'npm.cmd', 'npx', 'npx.cmd'].includes(normalized)) {
      throw new Error(`Archive bundles Node for ${target}: ${name}`)
    }
  }

  const verbose = await runProcess('tar', ['-tvzf', archivePath])
  for (const line of verbose.stdout.split(/\r?\n/).filter(Boolean)) {
    if (line[0] !== '-' && line[0] !== 'd') {
      throw new Error(`Archive contains a link or device for ${target}`)
    }
  }

  const packageJson = JSON.parse(
    (await runProcess('tar', ['-xOzf', archivePath, 'package.json'])).stdout,
  ) as {
    version?: string
    verbooDesktop?: { schemaVersion?: number; target?: string }
  }
  if (
    packageJson.version !== version ||
    packageJson.verbooDesktop?.schemaVersion !== 1 ||
    packageJson.verbooDesktop?.target !== target
  ) {
    throw new Error(`Archive package metadata mismatch for ${target}`)
  }
}

async function verifyWithMinisign(
  manifestPath: string,
  signaturePath: string,
  publicKeyPath: string,
): Promise<void> {
  await runProcess('minisign', [
    '-Vm',
    manifestPath,
    '-x',
    signaturePath,
    '-p',
    publicKeyPath,
  ])
}

async function hashFile(path: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256')
  let size = 0
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path)
    stream.on('data', chunk => {
      const bytes = chunk as Buffer
      size += bytes.length
      hash.update(bytes)
    })
    stream.on('error', rejectPromise)
    stream.on('end', resolvePromise)
  })
  return { size, sha256: hash.digest('hex') }
}

async function runProcess(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', rejectPromise)
    child.on('close', code => {
      if (code === 0) resolvePromise({ stdout, stderr })
      else rejectPromise(new Error(`${command} exited with ${code}: ${stderr.trim()}`))
    })
  })
}

function readArgument(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value) throw new Error(`Missing required argument: ${name}`)
  return value
}

if (import.meta.main) {
  const assetsDir = resolve(readArgument('--assets-dir'))
  const manifest = await verifyReleaseSet({
    assetsDir,
    manifestPath: join(assetsDir, 'verboo-cli-manifest.json'),
    signaturePath: join(assetsDir, 'verboo-cli-manifest.minisig'),
    publicKeyPath: resolve(readArgument('--public-key')),
  })
  process.stdout.write(`Verified Verboo CLI ${manifest.cliVersion}\n`)
}
