import { afterEach, expect, mock, test } from 'bun:test'
import axios from 'axios'

import {
  clearMarketplaceCache,
  fetchMarketplaceGroups,
} from './verbooMarketplace.js'

const originalGet = axios.get

afterEach(() => {
  axios.get = originalGet
  clearMarketplaceCache()
})

test('surfaces a marketplace lookup failure instead of treating it as no plans', async () => {
  axios.get = mock(async () => {
    throw new Error('timeout of 10000ms exceeded')
  }) as typeof axios.get

  await expect(fetchMarketplaceGroups({ force: true })).rejects.toThrow(
    'timeout of 10000ms exceeded',
  )
})

test('uses a non-empty stale marketplace cache after a transient failure', async () => {
  let calls = 0
  axios.get = mock(async () => {
    calls += 1
    if (calls === 1) {
      return {
        data: {
          data: [
            {
              id: 'group-id',
              name: 'Plano',
              slug: 'plano',
              priceCents: 1_000,
              currency: 'brl',
              billingInterval: 'month' as const,
              instances: [],
              paymentProvider: 'stripe' as const,
            },
          ],
        },
      }
    }
    throw new Error('temporary timeout')
  }) as typeof axios.get

  const initial = await fetchMarketplaceGroups({ force: true })
  const fallback = await fetchMarketplaceGroups({ force: true })

  expect(initial).toEqual(fallback)
  expect(fallback).toHaveLength(1)
})
