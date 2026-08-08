import { describe, expect, test } from 'bun:test'

import { DESKTOP_TARGETS } from './contract.js'
import { buildManifest } from './manifest.js'

describe('desktop CLI manifest generation', () => {
  test('sorts every artifact by the canonical target order', () => {
    const artifacts = [...DESKTOP_TARGETS]
      .reverse()
      .map(({ target }, index) => ({
        target,
        url: `https://example.invalid/${target}`,
        size: 100 + index,
        sha256: String(index).padStart(64, '0'),
        archive: 'tar.gz' as const,
      }))
    const manifest = buildManifest({
      version: '0.15.5',
      releasedAt: '2026-08-08T12:00:00.000Z',
      signingKeyId: '0123456789abcdef',
      artifacts,
    })

    expect(manifest.artifacts.map(item => item.target)).toEqual(
      DESKTOP_TARGETS.map(item => item.target),
    )
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      cliVersion: '0.15.5',
      desktopProtocol: 1,
      desktopVersion: { min: '0.7.0-beta', maxExclusive: '0.8.0' },
      node: { range: '>=24.0.0 <25.0.0', modules: '137', napi: '10' },
      signingKeyId: '0123456789abcdef',
    })
  })

  test('rejects a missing, duplicate, or malformed target record', () => {
    const artifacts = DESKTOP_TARGETS.map(({ target }) => ({
      target,
      url: `https://example.invalid/${target}`,
      size: 1,
      sha256: 'a'.repeat(64),
      archive: 'tar.gz' as const,
    }))
    expect(() =>
      buildManifest({
        version: '0.15.5',
        releasedAt: '2026-08-08T12:00:00.000Z',
        signingKeyId: '0123456789abcdef',
        artifacts: artifacts.slice(1),
      }),
    ).toThrow('exactly one artifact')
    expect(() =>
      buildManifest({
        version: '0.15.5',
        releasedAt: '2026-08-08T12:00:00.000Z',
        signingKeyId: '0123456789abcdef',
        artifacts: [...artifacts.slice(0, 3), artifacts[0]],
      }),
    ).toThrow('exactly one artifact')
    expect(() =>
      buildManifest({
        version: '0.15.5',
        releasedAt: 'not-a-date',
        signingKeyId: 'not-a-key-id',
        artifacts,
      }),
    ).toThrow('Invalid release timestamp')
  })
})
