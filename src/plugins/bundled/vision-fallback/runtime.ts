#!/usr/bin/env node
/**
 * Vision fallback runtime for the bundled plugin.
 *
 * Reads a UserPromptSubmit hook input from stdin, describes any image
 * attachments via the Verboo router, and writes hook output to stdout.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_PRIMARY_MODEL = 'ultra/qwen3.6-27b'
const DEFAULT_FALLBACK_MODEL = 'ultra/kimi-k2.7'
const PER_MODEL_TIMEOUT_MS = 30_000
const TOTAL_TIMEOUT_MS = 60_000

interface HookAttachment {
  type: 'image'
  source: 'base64' | 'file'
  mediaType: string
  data?: string
  path?: string
  filename?: string
}

interface HookInput {
  hook_event_name: string
  prompt: string
  cwd: string
  attachments?: HookAttachment[]
}

interface VisionModel {
  id: string
}

function logError(message: string): void {
  // eslint-disable-next-line no-console
  console.error(`[vision-fallback] ${message}`)
}

function getEnv(name: string): string | undefined {
  return process.env[name]
}

export function resolveApiKey(cwd: string): string | undefined {
  const envKey = getEnv('VISION_API_KEY')
  if (envKey && envKey.length > 0) return envKey

  const candidates = [
    join(cwd, 'opencode.json'),
    join(homedir(), '.config', 'opencode', 'opencode.json'),
    join(homedir(), '.verboo', 'opencode.json'),
  ]

  for (const path of candidates) {
    try {
      const raw = readFileSync(path, 'utf8')
      const parsed = JSON.parse(raw) as {
        provider?: { verboo?: { options?: { apiKey?: string } } }
      }
      const key = parsed.provider?.verboo?.options?.apiKey
      if (key) return key
    } catch {
      // ignore missing or invalid config
    }
  }

  return undefined
}

function buildVisionModels(): VisionModel[] {
  const primary = getEnv('VERBOO_VISION_PRIMARY_MODEL') ?? DEFAULT_PRIMARY_MODEL
  const fallback = getEnv('VERBOO_VISION_FALLBACK_MODEL') ?? DEFAULT_FALLBACK_MODEL
  return [
    { id: primary },
    ...fallback
      .split(/[\s,]+/)
      .map(id => id.trim())
      .filter(Boolean)
      .filter(id => id !== primary)
      .map(id => ({ id })),
  ]
}

async function describeWithModel(
  model: VisionModel,
  apiKey: string,
  attachments: HookAttachment[],
  signal: AbortSignal,
): Promise<string> {
  const baseURL =
    getEnv('VERBOO_VISION_BASE_URL') ?? 'https://code.verboo.ai/router/v1'
  const messages: Array<{
    role: 'user'
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >
  }> = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Descreva cada imagem em português de forma clara e concisa. Se for screenshot de interface, descreva os elementos visuais, textos e layout.',
        },
        ...attachments.map(attachment => {
          const url =
            attachment.source === 'file' && attachment.path
              ? `file://${attachment.path}`
              : `data:${attachment.mediaType};base64,${attachment.data ?? ''}`
          return {
            type: 'image_url' as const,
            image_url: { url },
          }
        }),
      ],
    },
  ]

  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: model.id,
      messages,
      max_tokens: 1024,
    }),
    signal,
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>
  }
  const content = data.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(part => part.text ?? '').join('')
  }
  throw new Error('Empty response from vision model')
}

export async function describeAttachments(
  input: HookInput,
  injectedApiKey?: string,
): Promise<{ additionalContext?: string }> {
  const attachments = input.attachments?.filter(a => a.type === 'image')
  if (!attachments || attachments.length === 0) {
    return {}
  }

  const apiKey = injectedApiKey ?? resolveApiKey(input.cwd)
  if (!apiKey) {
    return {
      additionalContext:
        'Aviso: não foi possível descrever a imagem anexada (credencial do router não encontrada).',
    }
  }

  const models = buildVisionModels()
  const startedAt = Date.now()
  const errors: string[] = []

  for (const model of models) {
    const remainingMs = TOTAL_TIMEOUT_MS - (Date.now() - startedAt)
    const timeoutMs = Math.min(PER_MODEL_TIMEOUT_MS, Math.max(remainingMs - 2000, 1000))
    if (timeoutMs <= 0) break

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const description = await describeWithModel(
        model,
        apiKey,
        attachments,
        controller.signal,
      )
      clearTimeout(timer)
      return { additionalContext: description }
    } catch (error) {
      clearTimeout(timer)
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`${model.id}: ${message}`)
    }
  }

  return {
    additionalContext: `Aviso: não foi possível descrever a imagem anexada (${errors.join('; ')}).`,
  }
}

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk)
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as HookInput

  const result = await describeAttachments(input)

  const output = result.additionalContext
    ? { hookSpecificOutput: { additionalContext: result.additionalContext } }
    : {}

  process.stdout.write(JSON.stringify(output))
}

main().catch(error => {
  logError(error instanceof Error ? error.message : String(error))
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        additionalContext:
          'Aviso: não foi possível descrever a imagem anexada (erro interno no vision-fallback).',
      },
    }),
  )
})
