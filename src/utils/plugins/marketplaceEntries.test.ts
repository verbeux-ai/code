import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, test } from 'bun:test'

import { PluginMarketplaceSchema, getSkippedMarketplaceEntries } from './schemas.js'
import { validateMarketplaceManifest } from './validatePlugin.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
  )
})

function marketplaceWith(plugins: unknown[]) {
  return {
    name: 'test-marketplace',
    owner: { name: 'Test' },
    plugins,
  }
}

const validEntry = {
  name: 'superpowers',
  source: './plugins/superpowers',
  description: 'Valid entry',
}

/**
 * A source type this build doesn't know yet. `claude-plugins-official` grew a
 * `command` source (the Xcode plugin, added 2026-11-06), which made every entry
 * in the marketplace unparseable and left users with "plugin not found" for
 * all of their installed plugins.
 */
const unknownSourceEntry = {
  name: 'xcode',
  source: {
    source: 'command',
    command: 'xcrun agent plugin path --plugin-format claude',
    mode: 'link',
  },
}

describe('PluginMarketplaceSchema plugin entries', () => {
  test('keeps valid entries when one entry has an unknown source type', () => {
    const result = PluginMarketplaceSchema().safeParse(
      marketplaceWith([validEntry, unknownSourceEntry]),
    )

    expect(result.success).toBe(true)
    expect(result.data?.plugins.map(p => p.name)).toEqual(['superpowers'])
  })

  test('keeps valid entries when an entry is malformed', () => {
    const result = PluginMarketplaceSchema().safeParse(
      marketplaceWith([
        validEntry,
        { name: 'has spaces', source: './plugins/spaces' },
        { source: './plugins/nameless' },
        'not-an-object',
      ]),
    )

    expect(result.success).toBe(true)
    expect(result.data?.plugins.map(p => p.name)).toEqual(['superpowers'])
  })

  test('parses an empty plugin list when every entry is invalid', () => {
    const result = PluginMarketplaceSchema().safeParse(
      marketplaceWith([unknownSourceEntry]),
    )

    expect(result.success).toBe(true)
    expect(result.data?.plugins).toEqual([])
  })

  test('still rejects a manifest whose plugins field is not an array', () => {
    const result = PluginMarketplaceSchema().safeParse({
      name: 'test-marketplace',
      owner: { name: 'Test' },
      plugins: { superpowers: validEntry },
    })

    expect(result.success).toBe(false)
  })

  test('still rejects a manifest without a name', () => {
    expect(
      PluginMarketplaceSchema().safeParse({ plugins: [validEntry] }).success,
    ).toBe(false)
  })

  test('parses a manifest whose owner metadata is missing', () => {
    // `owner` is display-only — nothing reads it. Requiring it means a
    // marketplace that drops or renames the field costs the user every plugin,
    // which is the same failure this file exists to prevent.
    const result = PluginMarketplaceSchema().safeParse({
      name: 'test-marketplace',
      plugins: [validEntry],
    })

    expect(result.success).toBe(true)
    expect(result.data?.plugins.map(p => p.name)).toEqual(['superpowers'])
    expect(result.data?.owner).toBeUndefined()
  })

  test('parses a manifest whose owner metadata is malformed', () => {
    const result = PluginMarketplaceSchema().safeParse({
      name: 'test-marketplace',
      owner: 'Anthropic',
      plugins: [validEntry],
    })

    expect(result.success).toBe(true)
    expect(result.data?.owner).toBeUndefined()
  })

  test('keeps the owner when it is well formed', () => {
    const result = PluginMarketplaceSchema().safeParse({
      name: 'test-marketplace',
      owner: { name: 'Anthropic', email: 'support@anthropic.com' },
      plugins: [validEntry],
    })

    expect(result.success).toBe(true)
    expect(result.data?.owner).toEqual({
      name: 'Anthropic',
      email: 'support@anthropic.com',
    })
  })

  test('still rejects a manifest without a name or with a bad plugins field', () => {
    expect(
      PluginMarketplaceSchema().safeParse({ name: 'x', plugins: [validEntry] })
        .success,
    ).toBe(true)
    expect(
      PluginMarketplaceSchema().safeParse({ name: 'x', plugins: null }).success,
    ).toBe(false)
  })

  test('applies entry defaults to the entries it keeps', () => {
    const result = PluginMarketplaceSchema().safeParse(
      marketplaceWith([validEntry]),
    )

    expect(result.success).toBe(true)
    expect(result.data?.plugins[0]?.strict).toBe(true)
  })

  test('keeps the entries a user has installed alongside the bad one', () => {
    // Shape of the real official marketplace on 2026-11-06: the Xcode entry
    // that broke the parse, next to the plugins support was getting reports
    // about.
    const result = PluginMarketplaceSchema().safeParse(
      marketplaceWith([
        { name: 'superpowers', source: './plugins/superpowers' },
        { name: 'frontend-design', source: './plugins/frontend-design' },
        unknownSourceEntry,
        { name: 'gopls-lsp', source: './plugins/gopls-lsp' },
      ]),
    )

    expect(result.success).toBe(true)
    expect(result.data?.plugins.map(p => p.name)).toEqual([
      'superpowers',
      'frontend-design',
      'gopls-lsp',
    ])
  })

  test('reports what it dropped, with the schema reason', () => {
    const result = PluginMarketplaceSchema().safeParse(
      marketplaceWith([validEntry, unknownSourceEntry]),
    )

    expect(result.success).toBe(true)
    expect(getSkippedMarketplaceEntries(result.data!)).toEqual([
      // Assert on the failing field, not the exact Zod message: the message
      // text is Zod's, the field is ours.
      { name: 'xcode', reason: expect.stringMatching(/^source: /) },
    ])
  })

  test('reports no skipped entries for a clean manifest', () => {
    const result = PluginMarketplaceSchema().safeParse(
      marketplaceWith([validEntry]),
    )

    expect(result.success).toBe(true)
    expect(getSkippedMarketplaceEntries(result.data!)).toEqual([])
  })

  test('names an entry that has no usable name by its position', () => {
    const result = PluginMarketplaceSchema().safeParse(
      marketplaceWith([validEntry, { source: './plugins/nameless' }]),
    )

    expect(result.success).toBe(true)
    expect(getSkippedMarketplaceEntries(result.data!).map(e => e.name)).toEqual(
      ['plugins[1]'],
    )
  })

  test('ties skipped entries to the parsed marketplace, not to its name', () => {
    // Delisting enforcement resolves marketplaces by their config key, which
    // can differ from the name the manifest declares. Keying by name would let
    // a dropped entry be read as a removal.
    const first = PluginMarketplaceSchema().safeParse(
      marketplaceWith([validEntry, unknownSourceEntry]),
    )
    const second = PluginMarketplaceSchema().safeParse(
      marketplaceWith([validEntry]),
    )

    expect(getSkippedMarketplaceEntries(first.data!).map(e => e.name)).toEqual(
      ['xcode'],
    )
    expect(getSkippedMarketplaceEntries(second.data!)).toEqual([])
  })
})

describe('validateMarketplaceManifest strictness', () => {
  test('reports an unknown source type instead of dropping the entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'marketplace-validate-'))
    tempDirs.push(dir)
    const filePath = join(dir, 'marketplace.json')
    await writeFile(
      filePath,
      JSON.stringify(marketplaceWith([validEntry, unknownSourceEntry]), null, 2),
    )

    const result = await validateMarketplaceManifest(filePath)

    expect(result.success).toBe(false)
    expect(result.errors.some(e => e.path === 'plugins.1.source')).toBe(true)
  })

  test('accepts a clean marketplace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'marketplace-validate-'))
    tempDirs.push(dir)
    const filePath = join(dir, 'marketplace.json')
    await writeFile(
      filePath,
      JSON.stringify(marketplaceWith([validEntry]), null, 2),
    )

    const result = await validateMarketplaceManifest(filePath)

    expect(result.success).toBe(true)
    expect(result.errors).toEqual([])
  })
})
