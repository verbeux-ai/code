import { expect, test } from 'bun:test'

import type { SubscriptionResponse } from '../api/verbooSubscriptions.js'
import { getPastDueAccessDecision } from './subscriptionAccess.js'

const NOW = new Date('2026-07-20T12:00:00Z').getTime()

function subscription(
  status: string,
  currentPeriodEnd?: string,
): SubscriptionResponse {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    groupId: '22222222-2222-4222-8222-222222222222',
    status,
    currentPeriodEnd,
    cancelAtPeriodEnd: false,
  }
}

test('blocks when the account only has past-due subscriptions', () => {
  expect(
    getPastDueAccessDecision([subscription('past_due')], NOW).kind,
  ).toBe('block')
})

test('warns and keeps the CLI available with a current active subscription', () => {
  expect(
    getPastDueAccessDecision(
      [subscription('past_due'), subscription('active')],
      NOW,
    ).kind,
  ).toBe('warn')
})

test('warns and keeps the CLI available with a current trialing subscription', () => {
  expect(
    getPastDueAccessDecision(
      [subscription('past_due'), subscription('trialing', '2026-07-21T12:00:00Z')],
      NOW,
    ).kind,
  ).toBe('warn')
})

test('does not treat an expired active subscription as valid access', () => {
  expect(
    getPastDueAccessDecision(
      [subscription('past_due'), subscription('active', '2026-07-19T12:00:00Z')],
      NOW,
    ).kind,
  ).toBe('block')
})

test('continues without a prompt when there is no past-due subscription', () => {
  expect(
    getPastDueAccessDecision([subscription('active')], NOW).kind,
  ).toBe('continue')
})
