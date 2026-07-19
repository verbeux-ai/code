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
const GROUP_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_GROUP_ID = '22222222-2222-4222-8222-222222222222'
const VERIFICATION_ID = '33333333-3333-4333-8333-333333333333'
const SUBSCRIPTION_ID = '44444444-4444-4444-8444-444444444444'

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
    createCheckoutSession('access-token', GROUP_ID, {
      paymentMethod: 'woovi',
      woovi: { taxId: '52998224725', phone: '11999999999' },
    }),
  ).resolves.toEqual({
    mode: 'woovi',
    wooviQrCode: '000201',
    wooviSubscriptionId: 'woovi-subscription',
  })

  expect(post).toHaveBeenCalledWith(
    `https://code.verboo.ai/api/me/groups/${GROUP_ID}/checkout`,
    {
      paymentMethod: 'woovi',
      woovi: { taxId: '52998224725', phone: '11999999999' },
    },
    expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer access-token',
      }),
    }),
  )
})

test('confirms only the Woovi subscription that became active', async () => {
  const get = mock(async () => ({
    data: {
      data: [
        {
          id: SUBSCRIPTION_ID,
          groupId: OTHER_GROUP_ID,
          wooviSubscriptionId: 'other',
          status: 'active',
          cancelAtPeriodEnd: false,
        },
        {
          id: SUBSCRIPTION_ID,
          groupId: GROUP_ID,
          wooviSubscriptionId: 'expected',
          status: 'incomplete',
          cancelAtPeriodEnd: false,
        },
      ],
    },
  }))
  axios.get = get as typeof axios.get

  await expect(
    isWooviSubscriptionActive('access-token', 'expected'),
  ).resolves.toBe(false)

  get.mockResolvedValueOnce({
    data: {
      data: [
        {
          id: SUBSCRIPTION_ID,
          groupId: GROUP_ID,
          wooviSubscriptionId: 'expected',
          status: 'active',
          cancelAtPeriodEnd: false,
        },
      ],
    },
  })
  await expect(
    isWooviSubscriptionActive('access-token', 'expected'),
  ).resolves.toBe(true)
})

test('starts a cardless trial with an international WhatsApp number', async () => {
  const post = mock(async () => ({
    data: {
      data: {
        mode: 'verification_required',
        verificationId: VERIFICATION_ID,
        maskedPhone: '+55 ••••••1234',
        expiresAt: '2026-07-19T12:00:00Z',
        resendAt: '2026-07-19T11:55:00Z',
        attemptsRemaining: 5,
      },
    },
  }))
  axios.post = post as typeof axios.post

  await expect(
    startCardlessTrial('access-token', GROUP_ID, {
      useVerifiedPhone: false,
      phone: '+5585999991234',
      countryCode: 'BR',
    }),
  ).resolves.toEqual({
    mode: 'verification_required',
    verificationId: VERIFICATION_ID,
    maskedPhone: '+55 ••••••1234',
    expiresAt: '2026-07-19T12:00:00Z',
    resendAt: '2026-07-19T11:55:00Z',
    attemptsRemaining: 5,
  })

  expect(post).toHaveBeenCalledWith(
    `https://code.verboo.ai/api/me/groups/${GROUP_ID}/cardless-trial`,
    {
      useVerifiedPhone: false,
      phone: '+5585999991234',
      countryCode: 'BR',
    },
    expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer access-token',
      }),
    }),
  )
})

test('loads a verified profile and confirms its six-digit code', async () => {
  const get = mock(async () => ({
    data: {
      data: {
        verified: true,
        maskedPhone: '+55 ••••••1234',
        countryCode: 'BR',
      },
    },
  }))
  const post = mock(async () => ({
    data: {
      data: { mode: 'trial_activated', groupId: GROUP_ID, status: 'trialing' },
    },
  }))
  axios.get = get as typeof axios.get
  axios.post = post as typeof axios.post

  await expect(getWhatsAppProfile('access-token')).resolves.toMatchObject({
    verified: true,
    countryCode: 'BR',
  })
  await expect(
    confirmCardlessTrial('access-token', VERIFICATION_ID, '123456'),
  ).resolves.toMatchObject({
    mode: 'trial_activated',
    status: 'trialing',
  })
  expect(post).toHaveBeenCalledWith(
    `https://code.verboo.ai/api/me/cardless-trial-verifications/${VERIFICATION_ID}/confirm`,
    { code: '123456' },
    expect.anything(),
  )
})

test('preserves backend error code, status, and retry-after', async () => {
  axios.post = mock(async () => {
    throw {
      isAxiosError: true,
      response: {
        status: 429,
        data: { error: 'too many attempts', code: 'rate_limited' },
        headers: { 'retry-after': '7' },
      },
    }
  }) as typeof axios.post

  await expect(
    confirmCardlessTrial('access-token', VERIFICATION_ID, '123456'),
  ).rejects.toMatchObject({
    status: 429,
    code: 'rate_limited',
    retryAfterSeconds: 7,
  })
})

test('rejects a malformed Woovi checkout response', async () => {
  axios.post = mock(async () => ({
    data: { data: { mode: 'woovi', wooviQrCode: '' } },
  })) as typeof axios.post

  await expect(
    createCheckoutSession('access-token', GROUP_ID, {
      paymentMethod: 'woovi',
      woovi: { taxId: '52998224725', phone: '11999999999' },
    }),
  ).rejects.toMatchObject({ code: 'contract_error' })
})

test('rejects invalid Woovi payer data before sending a request', async () => {
  const post = mock(async () => ({ data: { data: { mode: 'reactivated' } } }))
  axios.post = post as typeof axios.post

  await expect(
    createCheckoutSession('access-token', GROUP_ID, {
      paymentMethod: 'woovi',
      woovi: { taxId: '52998224724', phone: '11999999999' },
    }),
  ).rejects.toMatchObject({ code: 'invalid_request' })
  expect(post).not.toHaveBeenCalled()
})
