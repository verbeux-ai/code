import type { SubscriptionResponse } from '../api/verbooSubscriptions.js'

type SubscriptionAccessCandidate = Pick<
  SubscriptionResponse,
  'status' | 'currentPeriodEnd'
>

export type PastDueAccessDecision =
  | { kind: 'continue'; pastDueSubscriptions: SubscriptionResponse[] }
  | { kind: 'warn'; pastDueSubscriptions: SubscriptionResponse[] }
  | { kind: 'block'; pastDueSubscriptions: SubscriptionResponse[] }

/**
 * Mirrors the router's entitlement rule: active and trialing subscriptions
 * grant access only while their current period has not ended. A missing end
 * date represents an open current period.
 */
export function hasCurrentSubscriptionAccess(
  subscription: SubscriptionAccessCandidate,
  now = Date.now(),
): boolean {
  if (subscription.status !== 'active' && subscription.status !== 'trialing') {
    return false
  }
  if (!subscription.currentPeriodEnd) return true

  const periodEnd = new Date(subscription.currentPeriodEnd).getTime()
  return Number.isFinite(periodEnd) && periodEnd > now
}

export function hasCurrentSubscriptionEntitlement(
  subscriptions: SubscriptionAccessCandidate[],
  now = Date.now(),
): boolean {
  return subscriptions.some((subscription) =>
    hasCurrentSubscriptionAccess(subscription, now),
  )
}

/**
 * A past-due plan only blocks startup when no other subscription currently
 * grants access. This decision is deliberately local to the CLI: backend
 * authorization remains the source of truth for requests.
 */
export function getPastDueAccessDecision(
  subscriptions: SubscriptionResponse[],
  now = Date.now(),
): PastDueAccessDecision {
  const pastDueSubscriptions = subscriptions.filter(
    (subscription) => subscription.status === 'past_due',
  )
  if (pastDueSubscriptions.length === 0) {
    return { kind: 'continue', pastDueSubscriptions }
  }

  if (hasCurrentSubscriptionEntitlement(subscriptions, now)) {
    return { kind: 'warn', pastDueSubscriptions }
  }

  return { kind: 'block', pastDueSubscriptions }
}

export function formatPastDuePlanNames(
  subscriptions: SubscriptionResponse[],
): string {
  const names = subscriptions.map(
    (subscription) => subscription.group?.name ?? subscription.groupId,
  )
  if (names.length <= 1) return names[0] ?? ''
  if (names.length === 2) return `${names[0]} e ${names[1]}`
  return `${names.slice(0, -1).join(', ')} e ${names.at(-1)}`
}
