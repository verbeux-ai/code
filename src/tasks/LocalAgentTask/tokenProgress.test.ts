import { expect, test } from 'bun:test'
import {
  createProgressTracker,
  getProgressUpdate,
  syncProgressUsageFromMessages,
  updateProgressFromMessage,
} from './LocalAgentTask.js'
import { createAssistantMessage } from '../../utils/messages.js'

// BUG-1 regression: streaming (Verboo/OpenAI shim) yields assistant messages
// with zeroed usage; the real usage arrives in message_delta which mutates the
// yielded message in place AFTER the consumer already read it. Tool calls
// counted, tokens stuck at 0. syncProgressUsageFromMessages re-derives tokens
// from the accumulated references (which message_delta mutated).
test('syncProgressUsageFromMessages converges tokens after in-place usage mutation', () => {
  const tracker = createProgressTracker()
  const agentMessages: Parameters<typeof syncProgressUsageFromMessages>[1] = []

  // Request 1: text + Bash tool_use, both yielded with usage 0
  const m1 = createAssistantMessage({
    content: 'ok',
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: null,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      inference_geo: null,
      iterations: null,
      speed: null,
    },
  })
  const m2 = createAssistantMessage({
    content: [
      {
        type: 'tool_use',
        id: 'tu1',
        name: 'Bash',
        input: { command: 'ls' },
      },
    ],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: null,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      inference_geo: null,
      iterations: null,
      speed: null,
    },
  })

  // Consumer processes m1 then m2 as they arrive (usage still 0)
  agentMessages.push(m1, m2)
  for (const m of agentMessages) updateProgressFromMessage(tracker, m)
  syncProgressUsageFromMessages(tracker, agentMessages)
  expect(tracker.toolUseCount).toBe(1)
  expect(getProgressUpdate(tracker).tokenCount).toBe(0)

  // message_delta mutates ONLY the last message in place with the real usage
  ;(m2.message as { usage: unknown }).usage = {
    input_tokens: 1500,
    output_tokens: 40,
    cache_creation_input_tokens: 5000,
    cache_read_input_tokens: 0,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: null,
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    inference_geo: null,
    iterations: null,
    speed: null,
  }

  // Next message arrives (request 2) → recompute picks up the mutation
  const m3 = createAssistantMessage({
    content: [
      { type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: 'x' } },
    ],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: null,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      inference_geo: null,
      iterations: null,
      speed: null,
    },
  })
  agentMessages.push(m3)
  updateProgressFromMessage(tracker, m3)
  syncProgressUsageFromMessages(tracker, agentMessages)
  expect(tracker.toolUseCount).toBe(2)
  // input 1500 + cache 5000 (request 1, accumulated) + output 40; request 2 still pending
  expect(getProgressUpdate(tracker).tokenCount).toBe(6540)

  // Request 2's message_delta lands (mutates m3), agent ends → final recompute
  ;(m3.message as { usage: unknown }).usage = {
    input_tokens: 1700,
    output_tokens: 25,
    cache_creation_input_tokens: 5000,
    cache_read_input_tokens: 0,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: null,
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    inference_geo: null,
    iterations: null,
    speed: null,
  }
  syncProgressUsageFromMessages(tracker, agentMessages)
  // latest input 1700 + cache 5000, outputs 40 + 25 = 65
  expect(getProgressUpdate(tracker).tokenCount).toBe(6765)
})