import axios from 'axios'
import { z } from 'zod'

import { VERBOO_API_BASE_URL } from '../../constants/oauth.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { isValidCPF } from '../oauth/purchaseValidation.js'
import {
  parseApiEnvelope,
  parseRequest,
  toVerbooApiError,
} from './verbooApiError.js'
import { fetchSubscriptions } from './verbooSubscriptions.js'

const httpUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => value.startsWith('https://') || value.startsWith('http://'),
  )

const checkoutResultSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('stripe'), url: httpUrlSchema }).passthrough(),
  z
    .object({
      mode: z.literal('woovi'),
      wooviQrCode: z.string().min(1),
      wooviSubscriptionId: z.string().min(1),
    })
    .passthrough(),
  z.object({ mode: z.literal('reactivated') }).passthrough(),
])

const checkoutInputSchema = z
  .object({
    paymentMethod: z.enum(['stripe', 'woovi']),
    woovi: z
      .object({
        taxId: z
          .string()
          .regex(/^\d{11}$/)
          .refine(isValidCPF),
        phone: z.string().regex(/^\d{2}9\d{8}$/),
      })
      .optional(),
  })
  .superRefine((input, ctx) => {
    if (input.paymentMethod === 'woovi' && !input.woovi) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Woovi payer data is required',
      })
    }
    if (input.paymentMethod === 'stripe' && input.woovi) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Stripe checkout must not include Woovi data',
      })
    }
  })

const whatsappProfileSchema = z.discriminatedUnion('verified', [
  z
    .object({
      verified: z.literal(false),
      maskedPhone: z.string().optional(),
      countryCode: z.string().length(2).optional(),
    })
    .passthrough(),
  z
    .object({
      verified: z.literal(true),
      maskedPhone: z.string().min(1),
      countryCode: z.string().length(2),
      verifiedAt: z.string().datetime({ offset: true }).optional(),
    })
    .passthrough(),
])

const cardlessTrialInputSchema = z.discriminatedUnion('useVerifiedPhone', [
  z.object({ useVerifiedPhone: z.literal(true) }),
  z.object({
    useVerifiedPhone: z.literal(false),
    phone: z.string().regex(/^\+[1-9]\d{7,14}$/),
    countryCode: z.string().length(2),
  }),
])

const verificationRequiredSchema = z
  .object({
    mode: z.literal('verification_required'),
    verificationId: z.string().uuid(),
    maskedPhone: z.string().min(1),
    expiresAt: z.string().datetime({ offset: true }),
    resendAt: z.string().datetime({ offset: true }),
    attemptsRemaining: z.number().int().nonnegative(),
  })
  .passthrough()

const trialActivatedSchema = z
  .object({
    mode: z.literal('trial_activated'),
    groupId: z.string().uuid(),
    status: z.literal('trialing'),
  })
  .passthrough()

const cardlessTrialResultSchema = z.discriminatedUnion('mode', [
  verificationRequiredSchema,
  trialActivatedSchema,
])

export type CheckoutResult = z.infer<typeof checkoutResultSchema>
export type PaymentMethod = 'stripe' | 'woovi'
export type WooviCheckoutData = { taxId: string; phone: string }
export type CheckoutInput = {
  paymentMethod: PaymentMethod
  woovi?: WooviCheckoutData
}
export type WhatsAppProfile = z.infer<typeof whatsappProfileSchema>
export type CardlessTrialInput = z.input<typeof cardlessTrialInputSchema>
export type CardlessTrialResult = z.infer<typeof cardlessTrialResultSchema>

function authHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  }
}

async function postAndParse<T>(
  endpoint: string,
  accessToken: string,
  body: unknown,
  schema: z.ZodType<T>,
  contractName: string,
): Promise<T> {
  try {
    const response = await axios.post(endpoint, body, {
      headers: authHeaders(accessToken),
      timeout: 15_000,
    })
    return parseApiEnvelope(schema, response.data, contractName)
  } catch (error) {
    const apiError = toVerbooApiError(
      error,
      `Não foi possível concluir ${contractName}.`,
    )
    logError(apiError)
    logForDebugging(
      `[Checkout] ${apiError.code ?? apiError.kind}: ${apiError.message}`,
    )
    throw apiError
  }
}

export async function createCheckoutSession(
  accessToken: string,
  groupId: string,
  input: CheckoutInput,
): Promise<CheckoutResult> {
  parseRequest(z.string().uuid(), groupId, 'checkout')
  const request = parseRequest(checkoutInputSchema, input, 'checkout')
  return postAndParse(
    `${VERBOO_API_BASE_URL}/api/me/groups/${groupId}/checkout`,
    accessToken,
    request,
    checkoutResultSchema,
    'o checkout',
  )
}

export async function isWooviSubscriptionActive(
  accessToken: string,
  wooviSubscriptionId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<boolean> {
  const subscriptions = await fetchSubscriptions(accessToken, opts)
  return subscriptions.some(
    (sub) =>
      sub.wooviSubscriptionId === wooviSubscriptionId &&
      sub.status === 'active',
  )
}

export async function getWhatsAppProfile(
  accessToken: string,
): Promise<WhatsAppProfile> {
  const endpoint = `${VERBOO_API_BASE_URL}/api/me/whatsapp`
  try {
    const response = await axios.get(endpoint, {
      headers: authHeaders(accessToken),
      timeout: 10_000,
    })
    return parseApiEnvelope(
      whatsappProfileSchema,
      response.data,
      'perfil do WhatsApp',
    )
  } catch (error) {
    throw toVerbooApiError(
      error,
      'Não foi possível consultar o WhatsApp verificado.',
    )
  }
}

export async function startCardlessTrial(
  accessToken: string,
  groupId: string,
  input: CardlessTrialInput,
): Promise<CardlessTrialResult> {
  parseRequest(z.string().uuid(), groupId, 'trial')
  const request = parseRequest(cardlessTrialInputSchema, input, 'trial')
  return postAndParse(
    `${VERBOO_API_BASE_URL}/api/me/groups/${groupId}/cardless-trial`,
    accessToken,
    request,
    cardlessTrialResultSchema,
    'o trial',
  )
}

export async function confirmCardlessTrial(
  accessToken: string,
  verificationId: string,
  code: string,
): Promise<CardlessTrialResult> {
  parseRequest(z.string().uuid(), verificationId, 'confirmação do trial')
  const request = parseRequest(
    z.object({ code: z.string().regex(/^\d{6}$/) }),
    { code },
    'confirmação do trial',
  )
  return postAndParse(
    `${VERBOO_API_BASE_URL}/api/me/cardless-trial-verifications/${verificationId}/confirm`,
    accessToken,
    request,
    cardlessTrialResultSchema,
    'a confirmação do trial',
  )
}

export async function resendCardlessTrialCode(
  accessToken: string,
  verificationId: string,
): Promise<z.infer<typeof verificationRequiredSchema>> {
  parseRequest(z.string().uuid(), verificationId, 'reenvio do código')
  return postAndParse(
    `${VERBOO_API_BASE_URL}/api/me/cardless-trial-verifications/${verificationId}/resend`,
    accessToken,
    undefined,
    verificationRequiredSchema,
    'o reenvio do código',
  )
}

export async function isGroupSubscriptionActive(
  accessToken: string,
  groupId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<boolean> {
  const subscriptions = await fetchSubscriptions(accessToken, opts)
  return subscriptions.some(
    (sub) =>
      sub.groupId === groupId &&
      (sub.status === 'active' || sub.status === 'trialing'),
  )
}
