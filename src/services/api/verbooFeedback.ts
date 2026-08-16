import axios from 'axios'
import { randomUUID } from 'crypto'
import { z } from 'zod'

import { getOauthConfig } from '../../constants/oauth.js'
import { getClaudeAIOAuthTokensAsync } from '../../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { withOAuth401Retry } from '../../utils/http.js'
import { parseApiEnvelope } from './verbooApiError.js'

const optionSchema = z.object({
  id: z.string().uuid(),
  position: z.number().int().min(1).max(9),
  label: z.string().min(1).max(300),
})

const questionSchema = z.object({
  id: z.string().uuid(),
  position: z.number().int().min(1).max(5),
  type: z.enum(['single_choice', 'multiple_choice']),
  text: z.string().min(1).max(500),
  minSelections: z.number().int().min(1).max(9),
  maxSelections: z.number().int().min(1).max(9),
  options: z.array(optionSchema).min(2).max(9),
})

const offerSchema = z.object({
  deliveryId: z.string().uuid(),
  campaignId: z.string().uuid(),
  title: z.string().min(1).max(200),
  intro: z.string().max(1000),
  locale: z.enum(['pt', 'en']),
  questions: z.array(questionSchema).min(1).max(5),
})

export type VerbooFeedbackOffer = z.infer<typeof offerSchema>
export type VerbooFeedbackAnswer = { questionId: string; optionIds: string[] }

type OutboxEntry = NonNullable<NonNullable<ReturnType<typeof getGlobalConfig>['verbooFeedback']>['outbox']>[number]

async function accessToken(): Promise<string> {
  const tokens = await getClaudeAIOAuthTokensAsync()
  if (!tokens?.accessToken) throw new Error('Verboo feedback requires OAuth')
  return tokens.accessToken
}

function headers(token: string) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

export async function fetchNextVerbooFeedback(context: {
  locale: 'pt' | 'en'
  modelId: string
  provider: string
  cliVersion: string
  platform: string
  architecture: string
}): Promise<VerbooFeedbackOffer | null> {
  return withOAuth401Retry(async () => {
    const token = await accessToken()
    const response = await axios.post(
      `${getOauthConfig().BASE_API_URL}/api/me/feedback/next`,
      context,
      { headers: headers(token), timeout: 5_000 },
    )
    if (response.status === 204) return null
    return parseApiEnvelope(offerSchema, response.data, 'feedback')
  })
}

async function sendMutation(entry: Pick<OutboxEntry, 'deliveryId' | 'action' | 'answers'>): Promise<void> {
  await withOAuth401Retry(async () => {
    const token = await accessToken()
    const suffix = entry.action === 'response' ? 'response' : 'skip'
    await axios.post(
      `${getOauthConfig().BASE_API_URL}/api/me/feedback/deliveries/${entry.deliveryId}/${suffix}`,
      entry.action === 'response' ? { answers: entry.answers ?? [] } : undefined,
      { headers: headers(token), timeout: 5_000 },
    )
  })
}

export async function markVerbooFeedbackViewed(deliveryId: string): Promise<void> {
  try {
    await withOAuth401Retry(async () => {
      const token = await accessToken()
      await axios.post(
        `${getOauthConfig().BASE_API_URL}/api/me/feedback/deliveries/${deliveryId}/view`,
        undefined,
        { headers: headers(token), timeout: 5_000 },
      )
    })
  } catch {
    // Viewing is an aggregate hint; final skip/response mutations are durable.
  }
}

function remember(campaignId: string, deliveryId: string, status: 'skipped' | 'completed') {
  saveGlobalConfig(current => {
    const feedback = current.verbooFeedback ?? {}
    const receipts = [
      ...(feedback.receipts ?? []).filter(receipt => receipt.campaignId !== campaignId),
      { campaignId, deliveryId, status, recordedAt: Date.now() },
    ].slice(-100)
    return { ...current, verbooFeedback: { ...feedback, receipts } }
  })
}

function enqueue(entry: Omit<OutboxEntry, 'id' | 'attempts' | 'createdAt'>): OutboxEntry {
  const queuedEntry: OutboxEntry = { ...entry, id: randomUUID(), attempts: 0, createdAt: Date.now() }
  saveGlobalConfig(current => {
    const feedback = current.verbooFeedback ?? {}
    const outbox = [
      ...(feedback.outbox ?? []).filter(item => !(item.deliveryId === entry.deliveryId && item.action === entry.action)),
      queuedEntry,
    ].slice(-20)
    return { ...current, verbooFeedback: { ...feedback, outbox } }
  })
  return queuedEntry
}

function removeFromOutbox(id: string) {
  saveGlobalConfig(current => {
    const feedback = current.verbooFeedback ?? {}
    return { ...current, verbooFeedback: { ...feedback, outbox: (feedback.outbox ?? []).filter(item => item.id !== id) } }
  })
}

export async function finalizeVerbooFeedback(
  campaignId: string,
  deliveryId: string,
  action: 'skip' | 'response',
  answers?: VerbooFeedbackAnswer[],
): Promise<void> {
  remember(campaignId, deliveryId, action === 'response' ? 'completed' : 'skipped')
  // Persist before attempting the request so an immediate process exit cannot
  // lose a response. The backend mutation is idempotent, making retries safe.
  const entry = enqueue({ campaignId, deliveryId, action, answers })
  try {
    await sendMutation(entry)
    removeFromOutbox(entry.id)
  } catch {
    logForDebugging('[Verboo feedback] final mutation queued for retry')
  }
}

export function hasVerbooFeedbackReceipt(campaignId: string): boolean {
  return getGlobalConfig().verbooFeedback?.receipts?.some(receipt => receipt.campaignId === campaignId) ?? false
}

export async function flushVerbooFeedbackOutbox(): Promise<void> {
  const entries = getGlobalConfig().verbooFeedback?.outbox ?? []
  for (const entry of entries) {
    try {
      await sendMutation(entry)
      removeFromOutbox(entry.id)
    } catch {
      saveGlobalConfig(current => {
        const feedback = current.verbooFeedback ?? {}
        const outbox = (feedback.outbox ?? []).flatMap(item => {
          if (item.id !== entry.id) return [item]
          if (item.attempts >= 4) return []
          return [{ ...item, attempts: item.attempts + 1 }]
        })
        return { ...current, verbooFeedback: { ...feedback, outbox } }
      })
      logForDebugging('[Verboo feedback] final mutation remains queued')
    }
  }
}
