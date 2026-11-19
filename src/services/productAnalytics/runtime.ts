import { randomUUID } from 'node:crypto'
import { VERBOO_API_BASE_URL, isVerbooMode } from '../../constants/oauth.js'
import { getCachedVerbooModels } from '../api/verbooModels.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { publicBuildVersion } from '../../utils/version.js'
import { logForDebugging } from '../../utils/debug.js'
import { ProductAnalyticsClient, type ProductCheckpoint, type ProductFeature, type ProductFeatureOutcome } from './client.js'
import { hasHumanRequest } from './eligibility.js'

let client: ProductAnalyticsClient | undefined
let retry: ReturnType<typeof setInterval> | undefined
let interactiveOpened = false

/** The same Verboo account preference is shared with the desktop and dashboard. */
export function productAnalytics(): ProductAnalyticsClient {
  if (!client) client = new ProductAnalyticsClient({
    root: getClaudeConfigHomeDir(), apiOrigin: VERBOO_API_BASE_URL, appVersion: publicBuildVersion,
    token: async () => (await getSecureStorage().readAsync())?.verbooOauth?.accessToken,
  })
  return client
}

function startRetries(analytics: ProductAnalyticsClient): void {
  if (retry) return
  const failed = () => { logForDebugging('optional_product_analytics_unavailable', { level: 'debug' }) }
  retry = setInterval(() => { void analytics.primeCheckpoint().catch(failed); void analytics.flush().catch(failed) }, 15000)
  retry.unref?.()
  void analytics.primeCheckpoint().catch(failed)
  void analytics.flush().catch(failed)
}

/** Start collecting only a server time reference, without blocking the UI. */
export function prepareInteractiveProductAnalytics(): void {
  if (!isVerbooMode() || !process.stdin.isTTY || !process.stdout.isTTY) return
  try { startRetries(productAnalytics()) } catch { logForDebugging('optional_product_analytics_unavailable', { level: 'debug' }) }
}

/** Freeze the latest server reference before the action being observed. */
export function captureInteractiveProductCheckpoint(): ProductCheckpoint {
  try { return productAnalytics().captureCheckpoint() } catch { return undefined }
}

/** Observe one interactive process opening, without delaying the terminal. */
export function observeInteractiveProductOpen(occurredAt: number, accountId: string): void {
  if (interactiveOpened) return
  interactiveOpened = true
  const analytics = productAnalytics()
  const checkpoint = analytics.captureCheckpoint()
  startRetries(analytics)
  void analytics.observeOpen(occurredAt, accountId, checkpoint).catch(() => {
    logForDebugging('optional_product_analytics_unavailable', { level: 'debug' })
  })
}

/** Observe an actual completed OAuth login; refreshes and provider setup do not call this. */
export function observeInteractiveProductLogin(occurredAt: number, accountId: string, checkpoint: ProductCheckpoint): void {
  try {
    const analytics = productAnalytics()
    startRetries(analytics)
    void analytics.observeLogin(occurredAt, accountId, checkpoint).catch(() => {
      logForDebugging('optional_product_analytics_unavailable', { level: 'debug' })
    })
  } catch { logForDebugging('optional_product_analytics_unavailable', { level: 'debug' }) }
}

/** Prepare an observation without blocking the interactive user request. */
export function prepareInteractiveProductTurn(messages: unknown, model: string, startedAt: number, accountId: string): ((occurredAt: number) => void) | undefined {
  if (!hasHumanRequest(messages)) return undefined
  const user = (messages as Array<{ type?: string; isMeta?: boolean; isSidechain?: boolean; uuid?: string }>).find(message =>
    message?.type === 'user' && !message.isMeta && !message.isSidechain && typeof message.uuid === 'string')
  if (!user?.uuid) return undefined
  const cachedModels = getCachedVerbooModels()
  // A missing catalog makes the provider indeterminate; do not guess.
  if (isVerbooMode() && !cachedModels) return undefined
  const modality = isVerbooMode() && cachedModels?.some(candidate => candidate.id === model.trim().replace(/\[1m\]$/i, '')) ? 'verboo_gateway' : 'external'
  const analytics = productAnalytics()
  const checkpoint = analytics.captureCheckpoint()
  const failed = () => { logForDebugging('optional_product_analytics_unavailable', { level: 'debug' }) }
  startRetries(analytics)
  const turn = analytics.beginTurn(user.uuid, startedAt, accountId, checkpoint).catch(() => { failed(); return undefined })
  return occurredAt => { void turn.then(snapshot => snapshot && analytics.completeTurn(snapshot, modality, occurredAt)).catch(failed) }
}

/** Capture a bounded feature action before it runs; missing consent never delays the command. */
export function prepareInteractiveProductFeature(feature: ProductFeature, accountId: string, startedAt = Date.now()):
  ((outcome: ProductFeatureOutcome, occurredAt?: number) => void) | undefined {
  if (!accountId || !process.stdin.isTTY || !process.stdout.isTTY) return undefined
  try {
    const analytics = productAnalytics()
    const checkpoint = analytics.captureCheckpoint()
    const failed = () => { logForDebugging('optional_product_analytics_unavailable', { level: 'debug' }) }
    startRetries(analytics)
    const turn = analytics.beginFeature(feature, randomUUID(), startedAt, accountId, checkpoint).catch(() => {
      failed()
      return undefined
    })
    return (outcome, occurredAt = Date.now()) => {
      void turn.then(snapshot => snapshot && analytics.completeFeature(snapshot, outcome, occurredAt)).catch(failed)
    }
  } catch {
    logForDebugging('optional_product_analytics_unavailable', { level: 'debug' })
    return undefined
  }
}
