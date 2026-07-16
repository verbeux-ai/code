import { afterEach, expect, mock, test } from 'bun:test'
import axios from 'axios'

import {
  confirmCardlessTrial,
  createCheckoutSession,
  getWhatsAppProfile,
  isWooviSubscriptionActive,
  startCardlessTrial,
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

test('starts a cardless trial with an international WhatsApp number', async () => {
  const post = mock(async () => ({
    data: { data: { mode: 'verification_required', verificationId: 'verification-id', maskedPhone: '+55 ••••••1234' } },
  }))
  axios.post = post as typeof axios.post

  await expect(startCardlessTrial('access-token', 'group-id', {
    useVerifiedPhone: false,
    phone: '+5585999991234',
    countryCode: 'BR',
  })).resolves.toEqual({
    mode: 'verification_required',
    verificationId: 'verification-id',
    maskedPhone: '+55 ••••••1234',
  })

  expect(post).toHaveBeenCalledWith(
    'https://code.verboo.ai/api/me/groups/group-id/cardless-trial',
    {
      useVerifiedPhone: false,
      phone: '+5585999991234',
      countryCode: 'BR',
    },
    expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer access-token' }) }),
  )
})

test('loads a verified profile and confirms its six-digit code', async () => {
  const get = mock(async () => ({ data: { data: { verified: true, maskedPhone: '+55 ••••••1234', countryCode: 'BR' } } }))
  const post = mock(async () => ({ data: { data: { mode: 'trial_activated', groupId: 'group-id', status: 'trialing' } } }))
  axios.get = get as typeof axios.get
  axios.post = post as typeof axios.post

  await expect(getWhatsAppProfile('access-token')).resolves.toMatchObject({ verified: true, countryCode: 'BR' })
  await expect(confirmCardlessTrial('access-token', 'verification-id', '123456')).resolves.toMatchObject({
    mode: 'trial_activated',
    status: 'trialing',
  })
  expect(post).toHaveBeenCalledWith(
    'https://code.verboo.ai/api/me/cardless-trial-verifications/verification-id/confirm',
    { code: '123456' },
    expect.anything(),
  )
})
