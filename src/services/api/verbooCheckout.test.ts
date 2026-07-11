import { afterEach, expect, mock, test } from 'bun:test'
import axios from 'axios'

import {
  createCheckoutSession,
  isWooviSubscriptionActive,
} from './verbooCheckout.js'

const originalPost = axios.post
const originalGet = axios.get

afterEach(() => {
  axios.post = originalPost
  axios.get = originalGet
})

test('sends the explicit Woovi method and payer data to checkout', async () => {
  const post = mock(async () => ({
    data: {
      data: {
        mode: 'woovi' as const,
        wooviQrCode: '000201',
        wooviSubscriptionId: 'woovi-subscription',
      },
    },
  }))
  axios.post = post as typeof axios.post

  await expect(
    createCheckoutSession('access-token', 'group-id', {
      paymentMethod: 'woovi',
      woovi: { taxId: '52998224725', phone: '11999999999' },
    }),
  ).resolves.toEqual({
    mode: 'woovi',
    wooviQrCode: '000201',
    wooviSubscriptionId: 'woovi-subscription',
  })

  expect(post).toHaveBeenCalledWith(
    'https://code.verboo.ai/api/me/groups/group-id/checkout',
    {
      paymentMethod: 'woovi',
      woovi: { taxId: '52998224725', phone: '11999999999' },
    },
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer access-token' }),
    }),
  )
})

test('confirms only the Woovi subscription that became active', async () => {
  const get = mock(async () => ({
    data: {
      data: [
        { wooviSubscriptionId: 'other', status: 'active' },
        { wooviSubscriptionId: 'expected', status: 'incomplete' },
      ],
    },
  }))
  axios.get = get as typeof axios.get

  await expect(isWooviSubscriptionActive('access-token', 'expected')).resolves.toBe(false)

  get.mockResolvedValueOnce({
    data: { data: [{ wooviSubscriptionId: 'expected', status: 'active' }] },
  })
  await expect(isWooviSubscriptionActive('access-token', 'expected')).resolves.toBe(true)
})
