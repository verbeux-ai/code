import { afterEach, expect, mock, test } from 'bun:test'
import axios from 'axios'

import { fetchPortalUrl, fetchSubscriptions } from './verbooSubscriptions.js'

const originalGet = axios.get
const GROUP_ID = '11111111-1111-4111-8111-111111111111'
const SUBSCRIPTION_ID = '22222222-2222-4222-8222-222222222222'

afterEach(() => {
  axios.get = originalGet
})

test('validates subscription and portal response contracts', async () => {
  const get = mock(async (url: string) => {
    if (url.endsWith('/portal')) {
      return { data: { data: { url: 'https://billing.example/session' } } }
    }
    return {
      data: {
        data: [
          {
            id: SUBSCRIPTION_ID,
            groupId: GROUP_ID,
            status: 'past_due',
            cancelAtPeriodEnd: false,
          },
        ],
      },
    }
  })
  axios.get = get as typeof axios.get

  await expect(fetchSubscriptions('access-token')).resolves.toHaveLength(1)
  await expect(fetchPortalUrl('access-token')).resolves.toBe(
    'https://billing.example/session',
  )
})

test('does not turn a subscription API failure into an empty list', async () => {
  axios.get = mock(async () => {
    throw {
      isAxiosError: true,
      response: {
        status: 503,
        data: { error: 'unavailable', code: 'subscriptions_unavailable' },
        headers: {},
      },
    }
  }) as typeof axios.get

  await expect(fetchSubscriptions('access-token')).rejects.toMatchObject({
    status: 503,
    code: 'subscriptions_unavailable',
  })
})

test('rejects malformed subscription data', async () => {
  axios.get = mock(async () => ({
    data: { data: [{ id: 'not-a-uuid', status: 'active' }] },
  })) as typeof axios.get

  await expect(fetchSubscriptions('access-token')).rejects.toMatchObject({
    code: 'contract_error',
  })
})
