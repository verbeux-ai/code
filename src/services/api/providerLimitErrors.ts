/**
 * Recognizes "your plan/balance ran out" errors from the providers the user
 * connects with their own account (ChatGPT plan via Codex, OpenAI API key,
 * Anthropic API key). Unlike a temporary rate limit, retrying does not help;
 * the REPL offers to switch to a Verboo model instead.
 */
import type { ActiveModelProvider } from '../../utils/model/activeModelIdentity.js'

export const PROVIDER_LIMIT_MESSAGE_PREFIX = 'Limite da sua conta atingido:'

export type ProviderLimit = {
  /** User-facing name of the account that ran out (ChatGPT, OpenAI, Anthropic). */
  providerLabel: string
  /** When the plan window renews, if the provider said so. */
  resetsAt?: Date
}

function errorText(error: unknown): string {
  if (!error) return ''
  if (typeof error === 'string') return error
  const parts: string[] = []
  const record = error as { message?: unknown; error?: unknown; body?: unknown }
  if (typeof record.message === 'string') parts.push(record.message)
  for (const extra of [record.error, record.body]) {
    if (extra && typeof extra === 'object') {
      try {
        parts.push(JSON.stringify(extra))
      } catch {
        // Not serializable; the message is enough.
      }
    } else if (typeof extra === 'string') {
      parts.push(extra)
    }
  }
  return parts.join('\n')
}

function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | undefined)?.status
  return typeof status === 'number' ? status : undefined
}

function parseResetsAt(text: string, now: number): Date | undefined {
  const at = /"resets_at"\s*:\s*(\d{9,})/.exec(text)
  if (at) return new Date(Number(at[1]) * 1000)
  const inSeconds = /"resets_in_seconds"\s*:\s*(\d+)/.exec(text)
  if (inSeconds) return new Date(now + Number(inSeconds[1]) * 1000)
  return undefined
}

export function classifyProviderLimitError(
  error: unknown,
  provider: ActiveModelProvider,
  now = Date.now(),
): ProviderLimit | null {
  const text = errorText(error)
  const lower = text.toLowerCase()
  const status = errorStatus(error)

  if (provider === 'Codex') {
    if (
      lower.includes('usage_limit_reached') ||
      (status === 429 && lower.includes('usage limit'))
    ) {
      return { providerLabel: 'ChatGPT', resetsAt: parseResetsAt(text, now) }
    }
    return null
  }
  if (provider === 'OpenAI') {
    if (
      lower.includes('insufficient_quota') ||
      lower.includes('exceeded your current quota')
    ) {
      return { providerLabel: 'OpenAI' }
    }
    return null
  }
  if (provider === 'Claude') {
    if (lower.includes('credit balance is too low')) {
      return { providerLabel: 'Anthropic' }
    }
    return null
  }
  // Verboo models have their own plan messages from the router.
  return null
}

function formatResetsAt(resetsAt: Date, now: number): string {
  const sameDay = new Date(now).toDateString() === resetsAt.toDateString()
  const time = resetsAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  return sameDay
    ? time
    : `${resetsAt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${time}`
}

export function formatProviderLimitMessage(limit: ProviderLimit, now = Date.now()): string {
  const what = limit.providerLabel === 'ChatGPT'
    ? 'o limite do seu plano ChatGPT acabou'
    : `o saldo ou a cota da sua chave ${limit.providerLabel} acabou`
  const renews = limit.resetsAt ? ` (renova ${formatResetsAt(limit.resetsAt, now)})` : ''
  return `${PROVIDER_LIMIT_MESSAGE_PREFIX} ${what}${renews}. Você pode trocar para um modelo Verboo e continuar.`
}

/** What ran out, taken from the error text, for the REPL's switch dialog. */
export function limitSwitchReasonFromMessage(text: string): string | null {
  if (!text.startsWith(PROVIDER_LIMIT_MESSAGE_PREFIX)) return null
  return text.slice(PROVIDER_LIMIT_MESSAGE_PREFIX.length).trim()
}
