import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  DESKTOP_TARGETS,
  artifactName,
  manifestBytes,
  parseDesktopTarget,
  releaseAssetUrl,
} from './contract.js'

describe('desktop CLI release contract', () => {
  test('covers every Verboo Desktop target exactly once', () => {
    expect(DESKTOP_TARGETS.map(item => item.target)).toEqual([
      'aarch64-apple-darwin',
      'x86_64-apple-darwin',
      'x86_64-pc-windows-msvc',
      'x86_64-unknown-linux-gnu',
    ])
    expect(new Set(DESKTOP_TARGETS.map(item => item.target)).size).toBe(4)
  })

  test('uses target-qualified immutable artifact names', () => {
    expect(artifactName('0.15.5', 'aarch64-apple-darwin')).toBe(
      'verboo-cli-0.15.5-aarch64-apple-darwin.tar.gz',
    )
    expect(
      releaseAssetUrl(
        'verbeux-ai/code',
        'v0.15.5',
        'verboo-cli-0.15.5-aarch64-apple-darwin.tar.gz',
      ),
    ).toBe(
      'https://github.com/verbeux-ai/code/releases/download/v0.15.5/verboo-cli-0.15.5-aarch64-apple-darwin.tar.gz',
    )
  })

  test('rejects mutable repositories, malformed versions, and unknown targets', () => {
    expect(() => artifactName('latest', 'aarch64-apple-darwin')).toThrow(
      'Invalid CLI version',
    )
    expect(() => releaseAssetUrl('graseeel/code', 'v0.15.5', 'asset')).toThrow(
      'Unexpected release repository',
    )
    expect(() => parseDesktopTarget('arm64')).toThrow('Unsupported desktop target')
  })

  test('serializes the exact signed bytes with stable indentation and one final newline', () => {
    const raw = manifestBytes({ schemaVersion: 1 } as never)
    expect(new TextDecoder().decode(raw)).toBe('{\n  "schemaVersion": 1\n}\n')
  })

  test('keeps release publication out of pull-request jobs and behind upstream signing', async () => {
    const repositoryRoot = resolve(import.meta.dir, '..', '..')
    const [releaseWorkflow, pullRequestWorkflow] = await Promise.all([
      readFile(resolve(repositoryRoot, '.github/workflows/release.yml'), 'utf8'),
      readFile(resolve(repositoryRoot, '.github/workflows/pr-checks.yml'), 'utf8'),
    ])
    expect(releaseWorkflow).toContain("github.repository == 'verbeux-ai/code'")
    expect(releaseWorkflow).toContain('VERBOO_DESKTOP_MINISIGN_SECRET_KEY_B64')
    expect(releaseWorkflow).toContain('VERBOO_DESKTOP_MINISIGN_PUBLIC_KEY')
    expect(releaseWorkflow).toContain('MINISIGN_VERSION: "0.12"')
    expect(releaseWorkflow).toContain(
      '9a599b48ba6eb7b1e80f12f36b94ceca7c00b7a5173c95c3efc88d9822957e73',
    )
    expect(releaseWorkflow).not.toContain('apt-get install -y minisign')
    expect(releaseWorkflow).toContain('gh release upload')
    expect(releaseWorkflow).not.toContain('--clobber')
    expect(pullRequestWorkflow).not.toContain('gh release upload')
    for (const { target } of DESKTOP_TARGETS) {
      expect(pullRequestWorkflow).toContain(`target: ${target}`)
      expect(releaseWorkflow).toContain(`target: ${target}`)
    }
  })
})
