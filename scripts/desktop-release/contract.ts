import { createHash } from 'node:crypto'

export type DesktopTarget =
  | 'aarch64-apple-darwin'
  | 'x86_64-apple-darwin'
  | 'x86_64-pc-windows-msvc'
  | 'x86_64-unknown-linux-gnu'

export type DesktopTargetDefinition = {
  target: DesktopTarget
  runner: 'macos-15' | 'macos-15-intel' | 'windows-latest' | 'ubuntu-22.04'
  nodePlatform: 'darwin-arm64' | 'darwin-x64' | 'win-x64' | 'linux-x64'
}

export const DESKTOP_TARGETS = [
  {
    target: 'aarch64-apple-darwin',
    runner: 'macos-15',
    nodePlatform: 'darwin-arm64',
  },
  {
    target: 'x86_64-apple-darwin',
    runner: 'macos-15-intel',
    nodePlatform: 'darwin-x64',
  },
  {
    target: 'x86_64-pc-windows-msvc',
    runner: 'windows-latest',
    nodePlatform: 'win-x64',
  },
  {
    target: 'x86_64-unknown-linux-gnu',
    runner: 'ubuntu-22.04',
    nodePlatform: 'linux-x64',
  },
] as const satisfies readonly DesktopTargetDefinition[]

export type DesktopCliArtifact = {
  target: DesktopTarget
  url: string
  size: number
  sha256: string
  archive: 'tar.gz'
}

export type DesktopCliManifest = {
  schemaVersion: 1
  cliVersion: string
  releasedAt: string
  desktopProtocol: number
  desktopVersion: {
    min: string
    maxExclusive: string
  }
  node: {
    range: string
    modules: string
    napi: string
  }
  signingKeyId: string
  artifacts: DesktopCliArtifact[]
}

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function parseDesktopTarget(value: string): DesktopTarget {
  const match = DESKTOP_TARGETS.find(item => item.target === value)
  if (!match) {
    throw new Error(`Unsupported desktop target: ${value}`)
  }
  return match.target
}

export function artifactName(version: string, target: DesktopTarget): string {
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(`Invalid CLI version: ${version}`)
  }
  parseDesktopTarget(target)
  return `verboo-cli-${version}-${target}.tar.gz`
}

export function releaseAssetUrl(repository: string, tag: string, name: string): string {
  if (repository !== 'verbeux-ai/code') {
    throw new Error(`Unexpected release repository: ${repository}`)
  }
  if (!RELEASE_TAG_PATTERN.test(tag)) {
    throw new Error(`Invalid release tag: ${tag}`)
  }
  if (!/^verboo-cli-[0-9A-Za-z._-]+\.tar\.gz$/.test(name)) {
    throw new Error(`Invalid release asset name: ${name}`)
  }
  return `https://github.com/${repository}/releases/download/${tag}/${name}`
}

export function manifestBytes(manifest: DesktopCliManifest): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`)
}

export function signingKeyId(publicKeyText: string): string {
  const normalized = publicKeyText.trim()
  if (!normalized) throw new Error('Minisign public key is empty')
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16)
}
