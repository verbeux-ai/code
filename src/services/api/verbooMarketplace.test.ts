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

const GROUP_ID = '11111111-1111-4111-8111-111111111111'

test('surfaces a marketplace lookup failure instead of treating it as no plans', async () => {
  axios.get = mock(async () => {
    throw new Error('timeout of 10000ms exceeded')
  }) as typeof axios.get

  await expect(fetchMarketplaceGroups('access-token')).rejects.toThrow(
    'Não foi possível carregar os planos.',
  )
})

test('requests an authenticated CLI-only catalog and defensively drops API-only plans', async () => {
  const get = mock(async () => ({
    data: {
      data: [
        {
          id: GROUP_ID,
          name: 'Plano',
          slug: 'plano',
          priceCents: 1_000,
          currency: 'brl',
          billingInterval: 'month' as const,
          instances: [],
          paymentProvider: 'stripe' as const,
          trialEligible: false,
          apiOnly: true,
          isMember: false,
          isOnWaitlist: false,
          waitlistEnabled: false,
          waitlistSubscribersOnly: false,
        },
      ],
    },
  }))
  axios.get = get as typeof axios.get

  await expect(fetchMarketplaceGroups('access-token')).resolves.toEqual([])
  expect(get).toHaveBeenCalledWith(
    'https://code.verboo.ai/api/marketplace',
    expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer access-token',
      }),
      params: { apiOnly: false, includeMetrics: false },
    }),
  )
})

test('rejects an authenticated catalog without personalized trial eligibility', async () => {
  axios.get = mock(async () => ({
    data: {
      data: [
        {
          id: GROUP_ID,
          name: 'Plano',
          slug: 'plano',
          priceCents: 1_000,
          currency: 'brl',
          billingInterval: 'month',
          instances: [],
          paymentProvider: 'stripe',
          apiOnly: false,
          isMember: false,
          isOnWaitlist: false,
          waitlistEnabled: false,
          waitlistSubscribersOnly: false,
        },
      ],
    },
  })) as typeof axios.get

  await expect(fetchMarketplaceGroups('access-token')).rejects.toMatchObject({
    code: 'contract_error',
  })
})
