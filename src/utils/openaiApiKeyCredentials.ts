import { isBareMode } from './envUtils.js'
import { getSecureStorage, type SecureStorageData } from './secureStorage/index.js'

/** JSON key in the shared Verboo Code secure storage blob. */
export const OPENAI_API_KEY_STORAGE_KEY = 'openaiApiKey' as const

/** The user's own OpenAI API key (platform.openai.com), billed by OpenAI. */
export type OpenAIApiKeyCredential = {
  apiKey: string
  /** Last characters of the key, for status output. */
  keyHint: string
}

function storage() {
  return getSecureStorage({ allowPlainTextFallback: false })
}

/** OpenAI API keys start with sk- (sk-proj-, sk-svcacct-, legacy sk-…). */
export function looksLikeOpenAIApiKey(value: string): boolean {
  const trimmed = value.trim()
  return /^sk-[A-Za-z0-9_-]{20,}$/.test(trimmed) && !trimmed.startsWith('sk-ant-')
}

export function buildOpenAIApiKeyCredential(apiKey: string): OpenAIApiKeyCredential {
  const trimmed = apiKey.trim()
  return { apiKey: trimmed, keyHint: trimmed.slice(-4) }
}

function normalize(value: unknown): OpenAIApiKeyCredential | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const apiKey = typeof record.apiKey === 'string' ? record.apiKey.trim() : ''
  if (!apiKey) return undefined
  const keyHint = typeof record.keyHint === 'string' && record.keyHint.trim()
    ? record.keyHint.trim()
    : apiKey.slice(-4)
  return { apiKey, keyHint }
}

export function readOpenAIApiKeyCredential(): OpenAIApiKeyCredential | undefined {
  if (isBareMode()) return undefined
  try {
    const data = storage().read() as Record<string, unknown> | null
    return normalize(data?.[OPENAI_API_KEY_STORAGE_KEY])
  } catch {
    return undefined
  }
}

export async function readOpenAIApiKeyCredentialAsync(): Promise<
  OpenAIApiKeyCredential | undefined
> {
  if (isBareMode()) return undefined
  try {
    const data = (await storage().readAsync()) as Record<string, unknown> | null
    return normalize(data?.[OPENAI_API_KEY_STORAGE_KEY])
  } catch {
    return undefined
  }
}

export function saveOpenAIApiKeyCredential(
  credential: OpenAIApiKeyCredential,
): { success: boolean; warning?: string } {
  if (isBareMode()) {
    return { success: false, warning: 'Bare mode: secure storage is disabled.' }
  }
  const normalized = normalize(credential)
  if (!normalized) return { success: false, warning: 'A chave de API da OpenAI está vazia.' }
  const secureStorage = storage()
  const previous = (secureStorage.read() || {}) as Record<string, unknown>
  return secureStorage.update({
    ...previous,
    [OPENAI_API_KEY_STORAGE_KEY]: normalized,
  } as SecureStorageData)
}

export function clearOpenAIApiKeyCredential(): { success: boolean; warning?: string } {
  if (isBareMode()) return { success: true }
  const secureStorage = storage()
  const current = secureStorage.readResult?.()
  if (current?.kind === 'error') {
    return {
      success: false,
      warning: current.warning ?? 'Não foi possível ler o armazenamento seguro.',
    }
  }
  const previous = (secureStorage.read() || {}) as Record<string, unknown>
  if (!(OPENAI_API_KEY_STORAGE_KEY in previous)) return { success: true }
  const next = { ...previous }
  delete next[OPENAI_API_KEY_STORAGE_KEY]
  return secureStorage.update(next as SecureStorageData)
}
