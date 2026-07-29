import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  createOpenAIShimClient,
  setOpenAIShimRouterStatusHandler,
} from './openaiShim.ts'

type FetchType = typeof globalThis.fetch

const originalFetch = globalThis.fetch
const originalEnv = {
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  VERBOO_SLOW_HINT_MS: process.env.VERBOO_SLOW_HINT_MS,
}

beforeEach(() => {
  process.env.OPENAI_BASE_URL = 'http://example.test/v1'
  process.env.OPENAI_API_KEY = 'test-key'
})

afterEach(() => {
  globalThis.fetch = originalFetch
  setOpenAIShimRouterStatusHandler(null)
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const encoder = new TextEncoder()

// SSE response que ATRASA a emissão do primeiro chunk por `delayMs`, simulando
// um backend lento (cold start / preempção) que fica em silêncio antes de
// começar a responder — sem emitir o sinal router_status:"warming".
function makeDelayedSseResponse(lines: string[], delayMs: number): Response {
  let i = 0
  return new Response(
    new ReadableStream({
      async pull(controller) {
        if (i === 0 && delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs))
        }
        if (i < lines.length) {
          controller.enqueue(encoder.encode(lines[i]!))
          i++
        } else {
          controller.close()
        }
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  )
}

function contentChunks(): string[] {
  return [
    `data: ${JSON.stringify({
      id: 'c1',
      object: 'chat.completion.chunk',
      model: 'fake-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'oi' }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: 'c1',
      object: 'chat.completion.chunk',
      model: 'fake-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}\n\n`,
    'data: [DONE]\n\n',
  ]
}

async function drain(model = 'fake-model'): Promise<void> {
  const client = createOpenAIShimClient({}) as {
    beta: {
      messages: {
        create: (p: Record<string, unknown>) => {
          withResponse: () => Promise<{ data: AsyncIterable<unknown> }>
        }
      }
    }
  }
  const result = await client.beta.messages
    .create({
      model,
      system: 'test',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32,
      stream: true,
    })
    .withResponse()
  for await (const _ of result.data) {
    // consome o stream até o fim
  }
}

test('mostra warming-up por TEMPO quando o backend fica lento sem sinal do servidor', async () => {
  // limiar curto pra teste; primeiro chunk atrasa mais que o limiar
  process.env.VERBOO_SLOW_HINT_MS = '40'
  const statusCalls: (string | null)[] = []
  setOpenAIShimRouterStatusHandler((s) => statusCalls.push(s))

  globalThis.fetch = (async () =>
    makeDelayedSseResponse(contentChunks(), 150)) as unknown as FetchType

  await drain()

  // disparou o aviso 'warming-up' e depois limpou (null) ao chegar conteúdo
  expect(statusCalls).toContain('warming-up')
  expect(statusCalls[statusCalls.length - 1]).toBe(null)
  const firstWarm = statusCalls.indexOf('warming-up')
  const firstNull = statusCalls.indexOf(null)
  expect(firstWarm).toBeGreaterThanOrEqual(0)
  expect(firstNull).toBeGreaterThan(firstWarm)
})

test('mostra warming-up quando a REQUISIÇÃO fica pendurada antes de qualquer resposta (caso B)', async () => {
  // Aqui o atraso está no próprio fetch (a resposta HTTP nem começa) — o
  // cronômetro precisa contar desde o ENVIO, não só da leitura do corpo.
  process.env.VERBOO_SLOW_HINT_MS = '40'
  const statusCalls: (string | null)[] = []
  setOpenAIShimRouterStatusHandler((s) => statusCalls.push(s))

  globalThis.fetch = (async () => {
    await new Promise((r) => setTimeout(r, 150)) // requisição pendurada
    return makeDelayedSseResponse(contentChunks(), 0)
  }) as unknown as FetchType

  await drain()

  expect(statusCalls).toContain('warming-up')
  expect(statusCalls[statusCalls.length - 1]).toBe(null)
})

test('NÃO mostra warming-up quando a resposta chega rápido (sem flicker)', async () => {
  // limiar alto; chunk chega imediatamente
  process.env.VERBOO_SLOW_HINT_MS = '5000'
  const statusCalls: (string | null)[] = []
  setOpenAIShimRouterStatusHandler((s) => statusCalls.push(s))

  globalThis.fetch = (async () =>
    makeDelayedSseResponse(contentChunks(), 0)) as unknown as FetchType

  await drain()

  expect(statusCalls).not.toContain('warming-up')
})
