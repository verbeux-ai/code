import { describe, expect, test } from 'bun:test'
import { updatePluginsForMarketplaces } from './pluginAutoupdate.js'

describe('Verboo marketplace autoupdate', () => {
  test('refreshes the catalog without updating installed Verboo plugins', async () => {
    await expect(
      updatePluginsForMarketplaces(new Set(['verboo-plugins'])),
    ).resolves.toEqual([])
  })
})
