import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  DESKTOP_TARGETS,
  artifactName,
  manifestBytes,
  releaseAssetUrl,
  type DesktopCliArtifact,
  type DesktopCliManifest,
} from './contract.js'

export type BuildManifestInput = {
  version: string
  releasedAt: string
  signingKeyId: string
  artifacts: DesktopCliArtifact[]
}

export type BuildManifestFromAssetsInput = Omit<BuildManifestInput, 'artifacts'> & {
  assetsDir: string
  repository: string
  tag: string
}

export function buildManifest(input: BuildManifestInput): DesktopCliManifest {
  artifactName(input.version, 'aarch64-apple-darwin')
  if (!isCanonicalTimestamp(input.releasedAt)) {
    throw new Error(`Invalid release timestamp: ${input.releasedAt}`)
  }
  if (!/^[a-f0-9]{16}$/.test(input.signingKeyId)) {
    throw new Error(`Invalid signing key ID: ${input.signingKeyId}`)
  }

  const artifacts = DESKTOP_TARGETS.map(({ target }) => {
    const matches = input.artifacts.filter(item => item.target === target)
    if (matches.length !== 1) {
      throw new Error(`Manifest requires exactly one artifact for ${target}`)
    }
    const artifact = matches[0]
    if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) {
      throw new Error(`Invalid artifact size for ${target}`)
    }
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw new Error(`Invalid artifact SHA-256 for ${target}`)
    }
    if (artifact.archive !== 'tar.gz') {
      throw new Error(`Unsupported archive format for ${target}`)
    }
    return { ...artifact }
  })
  if (input.artifacts.length !== DESKTOP_TARGETS.length) {
    throw new Error('Manifest requires exactly one artifact for every desktop target')
  }

  return {
    schemaVersion: 1,
    cliVersion: input.version,
    releasedAt: input.releasedAt,
    desktopProtocol: 1,
    desktopVersion: {
      min: '0.7.0-beta',
      maxExclusive: '0.8.0',
    },
    node: {
      range: '>=24.0.0 <25.0.0',
      modules: '137',
      napi: '10',
    },
    signingKeyId: input.signingKeyId,
    artifacts,
  }
}

export async function buildManifestFromAssets(
  input: BuildManifestFromAssetsInput,
): Promise<DesktopCliManifest> {
  if (input.tag !== `v${input.version}`) {
    throw new Error(`Release tag ${input.tag} does not match CLI version ${input.version}`)
  }
  const artifacts: DesktopCliArtifact[] = []
  for (const { target } of DESKTOP_TARGETS) {
    const name = artifactName(input.version, target)
    const archivePath = join(input.assetsDir, name)
    const metadataPath = join(
      input.assetsDir,
      `${name.slice(0, -'.tar.gz'.length)}.metadata.json`,
    )
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      version?: string
      target?: string
      size?: number
      sha256?: string
    }
    if (metadata.version !== input.version || metadata.target !== target) {
      throw new Error(`Native metadata does not match ${target}`)
    }
    const actual = await hashFile(archivePath)
    if (metadata.size !== actual.size || metadata.sha256 !== actual.sha256) {
      throw new Error(`Native metadata mismatch for ${target}`)
    }
    artifacts.push({
      target,
      url: releaseAssetUrl(input.repository, input.tag, name),
      size: actual.size,
      sha256: actual.sha256,
      archive: 'tar.gz',
    })
  }
  return buildManifest({ ...input, artifacts })
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

function isCanonicalTimestamp(value: string): boolean {
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

function readArgument(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value) throw new Error(`Missing required argument: ${name}`)
  return value
}

if (import.meta.main) {
  const repositoryRoot = resolve(import.meta.dir, '..', '..')
  const packageJson = JSON.parse(
    await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
  ) as { version: string }
  const assetsDir = resolve(readArgument('--assets-dir'))
  const manifest = await buildManifestFromAssets({
    assetsDir,
    repository: readArgument('--repository'),
    tag: readArgument('--tag'),
    version: packageJson.version,
    releasedAt: readArgument('--released-at'),
    signingKeyId: readArgument('--signing-key-id'),
  })
  const destination = join(assetsDir, 'verboo-cli-manifest.json')
  await writeFile(destination, manifestBytes(manifest))
  process.stdout.write(`${destination}\n`)
}
