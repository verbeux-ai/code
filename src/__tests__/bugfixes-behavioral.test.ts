import { describe, test, expect, beforeEach } from 'bun:test'
import {
  createAssistantAPIErrorMessage,
  handleMessageFromStream,
  type StreamingToolUse,
} from '../utils/messages.ts'
import {
  createWatchdogState,
  tickWaitingWatchdog,
  WAITING_HEARTBEAT_MS,
  WAITING_STALL_TIMEOUT_MS,
  type WatchdogState,
  type TaskProgressItem,
} from '../utils/watchdog.ts'

// ---------------------------------------------------------------------------
// messages.ts: isApiErrorMessage resets stream mode (H3)
// ---------------------------------------------------------------------------
describe('messages.ts stream mode reset for API error messages', () => {
  test('handleMessageFromStream calls onSetStreamMode for isApiErrorMessage', () => {
    const msg = createAssistantAPIErrorMessage({
      content: 'Test error',
      error: 'unknown',
    })

    const streamModeCalls: string[] = []
    let streamingToolUses: StreamingToolUse[] = [
      {
        index: 0,
        contentBlock: {
          type: 'tool_use',
          id: 'stale_after_transport_error',
          name: 'Read',
          input: {},
        },
        unparsedToolInput: '{"file_path":"partial',
      },
    ]
    const callbacks = {
      onMessage: () => {},
      onUpdateLength: () => {},
      onSetStreamMode: (mode: string) => {
        streamModeCalls.push(mode)
      },
      onStreamingToolUses: (
        update: (current: StreamingToolUse[]) => StreamingToolUse[],
      ) => {
        streamingToolUses = update(streamingToolUses)
      },
    }

    handleMessageFromStream(
      msg,
      callbacks.onMessage,
      callbacks.onUpdateLength,
      callbacks.onSetStreamMode as (mode: string) => void,
      callbacks.onStreamingToolUses,
    )

    expect(streamModeCalls).toContain('tool-use')
    expect(streamingToolUses).toEqual([])
  })
})

describe('messages.ts idempotent streaming tool state', () => {
  test('duplicate tool starts keep one entry and preserve JSON deltas', () => {
    let streamingToolUses: StreamingToolUse[] = []
    const handle = (event: Record<string, unknown>) =>
      handleMessageFromStream(
        { type: 'stream_event', event } as never,
        () => {},
        () => {},
        () => {},
        update => {
          streamingToolUses = update(streamingToolUses)
        },
      )

    handle({
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'call_read',
        name: 'Read',
        input: {},
      },
    })
    handle({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"file_' },
    })
    handle({
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'call_read',
        name: 'Read',
        input: {},
      },
    })
    handle({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: 'path":"x"}' },
    })

    expect(streamingToolUses).toHaveLength(1)
    expect(streamingToolUses[0]?.contentBlock.id).toBe('call_read')
    expect(streamingToolUses[0]?.contentBlock.name).toBe('Read')
    expect(streamingToolUses[0]?.unparsedToolInput).toBe(
      '{"file_path":"x"}',
    )
  })

  test('message_start clears stale tool state left by an interrupted stream', () => {
    let streamingToolUses: StreamingToolUse[] = [
      {
        index: 0,
        contentBlock: {
          type: 'tool_use',
          id: 'stale_call',
          name: 'Read',
          input: {},
        },
        unparsedToolInput: '{"stale":true}',
      },
    ]

    handleMessageFromStream(
      {
        type: 'stream_event',
        event: { type: 'message_start', message: {} },
      } as never,
      () => {},
      () => {},
      () => {},
      update => {
        streamingToolUses = update(streamingToolUses)
      },
    )

    expect(streamingToolUses).toEqual([])
  })

  test('same ID at a different index remains a distinct protocol call', () => {
    let streamingToolUses: StreamingToolUse[] = []
    const handleStart = (index: number) =>
      handleMessageFromStream(
        {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index,
            content_block: {
              type: 'tool_use',
              id: 'shared_id',
              name: 'Read',
              input: {},
            },
          },
        } as never,
        () => {},
        () => {},
        () => {},
        update => {
          streamingToolUses = update(streamingToolUses)
        },
      )

    handleStart(0)
    handleStart(1)

    expect(streamingToolUses.map(toolUse => toolUse.index)).toEqual([0, 1])
  })

  test('reusing an index with a new ID replaces stale identity and input', () => {
    let streamingToolUses: StreamingToolUse[] = []
    const handle = (event: Record<string, unknown>) =>
      handleMessageFromStream(
        { type: 'stream_event', event } as never,
        () => {},
        () => {},
        () => {},
        update => {
          streamingToolUses = update(streamingToolUses)
        },
      )

    handle({
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'old_call',
        name: 'Read',
        input: {},
      },
    })
    handle({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"old":true}' },
    })
    handle({
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'new_call',
        name: 'Bash',
        input: {},
      },
    })

    expect(streamingToolUses).toHaveLength(1)
    expect(streamingToolUses[0]?.contentBlock.id).toBe('new_call')
    expect(streamingToolUses[0]?.unparsedToolInput).toBe('')
  })
})

// ---------------------------------------------------------------------------
// watchdog.ts: Behavioral tests with deterministic clock
// ---------------------------------------------------------------------------
describe('watchdog.ts deterministic behavioral tests', () => {
  let state: WatchdogState
  let logs: Array<{ level: string; event: string; details: Record<string, unknown> }>

  const mockLog = (level: 'info' | 'warn', event: string, details: Record<string, unknown>) => {
    logs.push({ level, event, details })
  }

  const baseTasks: TaskProgressItem[] = [
    { id: 'task-1', type: 'local_agent', outputOffset: 10 },
  ]

  beforeEach(() => {
    logs = []
    state = createWatchdogState(100_000)
    tickWaitingWatchdog(state, baseTasks, 0, mockLog, 100_000)
  })

  test('no heartbeat or stall when elapsed < WAITING_HEARTBEAT_MS', () => {
    const result = tickWaitingWatchdog(
      state,
      baseTasks,
      0,
      mockLog,
      100_000 + WAITING_HEARTBEAT_MS - 1,
    )
    expect(result.action).toBe('none')
    expect(logs).toHaveLength(0)
  })

  test('heartbeat fires when elapsed >= WAITING_HEARTBEAT_MS', () => {
    const result = tickWaitingWatchdog(
      state,
      baseTasks,
      0,
      mockLog,
      100_000 + WAITING_HEARTBEAT_MS,
    )
    expect(result.action).toBe('heartbeat')
    expect(logs).toHaveLength(1)
    expect(logs[0].level).toBe('info')
    expect(logs[0].event).toBe('waiting_for_agents')
  })

  test('heartbeat rate-limited to once per WAITING_HEARTBEAT_MS', () => {
    // First heartbeat at 30s
    tickWaitingWatchdog(state, baseTasks, 0, mockLog, 100_000 + WAITING_HEARTBEAT_MS)
    expect(logs).toHaveLength(1)

    // Tick 100ms later -> no new log
    tickWaitingWatchdog(state, baseTasks, 0, mockLog, 100_000 + WAITING_HEARTBEAT_MS + 100)
    expect(logs).toHaveLength(1)

    // Tick 5s later -> no new log
    tickWaitingWatchdog(state, baseTasks, 0, mockLog, 100_000 + WAITING_HEARTBEAT_MS + 5_000)
    expect(logs).toHaveLength(1)

    // Tick after another 30s passes -> second heartbeat fires
    tickWaitingWatchdog(state, baseTasks, 0, mockLog, 100_000 + 2 * WAITING_HEARTBEAT_MS)
    expect(logs).toHaveLength(2)
    expect(logs[1].event).toBe('waiting_for_agents')
  })

  test('stall warning fires once after WAITING_STALL_TIMEOUT_MS of inactivity', () => {
    const stallTime = 100_000 + WAITING_STALL_TIMEOUT_MS
    const res1 = tickWaitingWatchdog(state, baseTasks, 0, mockLog, stallTime)
    expect(res1.action).toBe('stall')
    expect(logs).toHaveLength(1)
    expect(logs[0].level).toBe('warn')
    expect(logs[0].event).toBe('waiting_for_agents_stalled')

    // Subsequent ticks during continued stall do not re-emit warning
    const res2 = tickWaitingWatchdog(state, baseTasks, 0, mockLog, stallTime + 5_000)
    expect(res2.action).toBe('none')
    expect(logs).toHaveLength(1)
  })

  test('progress in outputOffset resets stall state', () => {
    const stallTime = 100_000 + WAITING_STALL_TIMEOUT_MS
    tickWaitingWatchdog(state, baseTasks, 0, mockLog, stallTime)
    expect(logs).toHaveLength(1)

    // Output offset advances (e.g. agent produced log output)
    const updatedTasks: TaskProgressItem[] = [
      { id: 'task-1', type: 'local_agent', outputOffset: 250 },
    ]
    const progressTime = stallTime + 1_000
    const res = tickWaitingWatchdog(state, updatedTasks, 0, mockLog, progressTime)

    // Reset occurs, state.loggedStall is cleared
    expect(state.loggedStall).toBe(false)
    expect(state.lastProgressMs).toBe(progressTime)
    expect(res.action).toBe('none')
  })

  test('progress in sdkEventCount resets stall state', () => {
    const stallTime = 100_000 + WAITING_STALL_TIMEOUT_MS
    tickWaitingWatchdog(state, baseTasks, 0, mockLog, stallTime)
    expect(logs).toHaveLength(1)

    // New SDK event arrives
    const progressTime = stallTime + 500
    tickWaitingWatchdog(state, baseTasks, 1, mockLog, progressTime)

    expect(state.loggedStall).toBe(false)
    expect(state.lastProgressMs).toBe(progressTime)
  })

  test('watchdog never alters task lifecycle or breaks execution loop', () => {
    const stallTime = 100_000 + WAITING_STALL_TIMEOUT_MS * 2
    const res = tickWaitingWatchdog(state, baseTasks, 0, mockLog, stallTime)
    // Always returns purely informational action ('stall', 'heartbeat', 'none')
    // never returns a command to abort/kill or mutate task status.
    expect(['none', 'heartbeat', 'stall']).toContain(res.action)
  })

  test('first tick initializes lastProgressMs to prevent false stall when waiting_for_agents starts late', () => {
    // Create state at time 100_000
    const state = createWatchdogState(100_000)
    logs = []

    // First tick happens much later (100s after state creation)
    // Without the fix, elapsed would be 100_000ms → false stall
    // With the fix, lastProgressMs is set to nowMs on first tick
    const result = tickWaitingWatchdog(
      state,
      baseTasks,
      0,
      mockLog,
      200_000,
    )

    // Should NOT stall because first tick resets lastProgressMs
    expect(result.action).not.toBe('stall')
    expect(state.lastProgressMs).toBe(200_000)
  })

  test('empty task list initializes only once', () => {
    const state = createWatchdogState(100_000)
    tickWaitingWatchdog(state, [], 0, mockLog, 200_000)

    const result = tickWaitingWatchdog(
      state,
      [],
      0,
      mockLog,
      200_000 + WAITING_STALL_TIMEOUT_MS,
    )

    expect(result.action).toBe('stall')
  })
})
