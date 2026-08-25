import { expect, test } from 'bun:test'

import type { SubscriptionResponse } from '../api/verbooSubscriptions.js'
import { buildCLIEntitlementFromSubscriptions } from './cliEntitlement.js'

const now = Date.parse('2026-08-06T12:00:00.000Z')

function subscription(
  status: string,
  currentPeriodEnd?: string,
  source?: SubscriptionResponse['source'],
): SubscriptionResponse {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    groupId: '00000000-0000-4000-8000-000000000002',
    status,
    currentPeriodEnd,
    source,
    cancelAtPeriodEnd: false,
  }
}

test('derives CLI access from the existing subscriptions response', () => {
  expect(
    buildCLIEntitlementFromSubscriptions(
      [subscription('active', '2026-08-07T12:00:00.000Z')],
      now,
    ),
  ).toMatchObject({
    allowed: true,
    reason: 'active',
    validUntil: '2026-08-07T12:00:00.000Z',
  })

  expect(
    buildCLIEntitlementFromSubscriptions(
      [subscription('trialing', '2026-08-07T12:00:00.000Z')],
      now,
    ),
  ).toMatchObject({ allowed: true, reason: 'trialing' })

  expect(
    buildCLIEntitlementFromSubscriptions([subscription('past_due')], now),
  ).toMatchObject({ allowed: false, reason: 'past_due' })

  expect(buildCLIEntitlementFromSubscriptions([], now)).toMatchObject({
    allowed: false,
    reason: 'subscription_required',
  })
})

test('allows a CLI session backed only by an active managed seat', () => {
  expect(
    buildCLIEntitlementFromSubscriptions(
      [subscription('active', undefined, 'managed_seat')],
      now,
    ),
  ).toMatchObject({ allowed: true, reason: 'active' })
})
