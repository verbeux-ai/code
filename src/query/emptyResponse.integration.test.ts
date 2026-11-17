import { describe, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../Tool.js'
import { query } from '../query.js'
import type { SystemPrompt } from '../utils/systemPromptType.js'
import type { QueryDeps } from './deps.js'

function createToolUseContext(): ToolUseContext {
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'gpt-6-luna',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: {
        agents: [],
        activeAgents: [],
        allowedAgentTypes: [],
        errors: [],
      },
    },
    abortController: new AbortController(),
    readFileState: {},
    getAppState: () =>
      ({
        toolPermissionContext: getEmptyToolPermissionContext(),
        mainLoopModelForSession: 'gpt-6-luna',
        mainLoopModel: 'gpt-6-luna',
        mcp: { clients: [], tools: [] },
        sessionHooks: new Map(),
        fastMode: false,
        effortValue: 'high',
      }) as never,
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as ToolUseContext
}

describe('query empty model response recovery', () => {
  test('retries once, then returns a visible API error instead of silently completing', async () => {
    let callCount = 0
    let observed = 0
    const deps = {
      callModel: async function* () {
        callCount++
        yield {
          type: 'stream_event',
          event: {
            type: 'message_start',
            message: {
              type: 'message',
              role: 'assistant',
              content: [],
              stop_reason: null,
            },
          },
        }
        yield {
          type: 'stream_event',
          event: {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
          },
        }
        yield {
          type: 'stream_event',
          event: { type: 'message_stop' },
        }
      },
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({ wasCompacted: false }),
      uuid: () => `test-${callCount}`,
    } as unknown as QueryDeps

    const messages: unknown[] = []
    for await (const message of query({
      messages: [
        {
          type: 'user',
          message: { role: 'user', content: 'install the downloaded app' },
        },
      ],
      systemPrompt: [] as unknown as SystemPrompt,
      userContext: {},
      systemContext: {},
      canUseTool: async () => ({ behavior: 'allow' }) as never,
      toolUseContext: createToolUseContext(),
      querySource: 'repl_main_thread',
      onProductResponse: () => { observed++ },
      deps,
    })) {
      messages.push(message)
    }

    expect(callCount).toBe(2)
    expect(observed).toBe(0)
    const visibleError = messages.find(
      (message: any) =>
        message?.type === 'assistant' && message.isApiErrorMessage === true,
    ) as any
    expect(visibleError).toBeDefined()
    expect(visibleError.message.content[0].text).toContain(
      'no assistant response after 2 attempts',
    )
  })
  test('observes a complete response without passing its text to the callback', async () => {
    let observations = 0
    const deps = {
      callModel: async function* () {
        yield { type: 'assistant', uuid: 'fixture-response', isApiErrorMessage: false, message: {
          id: 'message-fixture', role: 'assistant', model: 'fixture-model', stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'private response' }], usage: { input_tokens: 1, output_tokens: 1 },
        } }
      },
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({ wasCompacted: false }),
      uuid: () => 'fixture',
    } as unknown as QueryDeps
    for await (const _message of query({
      messages: [{ type: 'user', message: { role: 'user', content: 'private prompt' } }],
      systemPrompt: [] as unknown as SystemPrompt, userContext: {}, systemContext: {},
      canUseTool: async () => ({ behavior: 'allow' }) as never, toolUseContext: createToolUseContext(),
      querySource: 'repl_main_thread', onProductResponse: (...args: unknown[]) => { expect(args).toEqual([]); observations++ }, deps,
    })) { /* Consume the real query loop. */ }
    expect(observations).toBe(1)
  })

})
