import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  BROWSER_BRIDGE_PROTOCOL_VERSION,
  NATIVE_MESSAGING_HOST_NAME,
  createNativeBridge,
} from './bridge.js'

function eventHook() {
  const listeners = []
  return {
    addListener(listener) {
      listeners.push(listener)
    },
    emit(...args) {
      for (const listener of listeners) listener(...args)
    },
  }
}

function nativePort() {
  return {
    posted: [],
    disconnected: false,
    onMessage: eventHook(),
    onDisconnect: eventHook(),
    postMessage(message) {
      this.posted.push(message)
    },
    disconnect() {
      this.disconnected = true
      this.onDisconnect.emit()
    },
  }
}

function fixture(overrides = {}) {
  const ports = []
  const onStartup = eventHook()
  const chromeApi = {
    runtime: {
      onStartup,
      connectNative(name) {
        assert.equal(name, NATIVE_MESSAGING_HOST_NAME)
        const port = nativePort()
        ports.push(port)
        return port
      },
    },
  }
  const calls = []
  const presenceClears = []
  const pendingApprovalCancels = []
  const executeWithApproval = async (toolCall, _contextFactory, approvalUi) => {
    calls.push(toolCall)
    if (overrides.requireApproval) {
      await approvalUi.request({ toolCall, policy: { needsApproval: true } })
    }
    return { ok: true, result: { title: 'Verboo' }, toolCall }
  }
  const bridge = createNativeBridge({
    chromeApi,
    executeWithApproval: overrides.executeWithApproval ?? executeWithApproval,
    contextFactory: async () => ({ mode: 'manual' }),
    approvalUiFactory: overrides.approvalUiFactory ?? (() => ({ request: async () => 'once' })),
    isApprovalUiAvailable: () => overrides.approvalUiAvailable ?? true,
    cancelPendingApprovals: overrides.cancelPendingApprovals ?? (() => {
      pendingApprovalCancels.push(true)
    }),
    clearPresenceOnAllTabs: overrides.clearPresenceOnAllTabs ?? (async () => {
      presenceClears.push(true)
    }),
    reconnectDelayMs: 0,
  })
  return {
    bridge,
    calls,
    chromeApi,
    ports,
    presenceClears,
    pendingApprovalCancels,
  }
}

function validRequest(id = 'request-1') {
  return {
    version: BROWSER_BRIDGE_PROTOCOL_VERSION,
    id,
    kind: 'toolRequest',
    payload: {
      name: 'read_page',
      arguments: { selector: 'main' },
    },
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('native tool requests use the shared approval executor', async () => {
  const { bridge, calls, ports } = fixture()
  assert.equal(bridge.connect(), true)

  ports[0].onMessage.emit(validRequest())
  await tick()

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    id: 'request-1',
    name: 'read_page',
    params: { selector: 'main' },
  })
  assert.equal(ports[0].posted[0].kind, 'toolResponse')
  assert.equal(ports[0].posted[0].id, 'request-1')
})

test('turn completion clears presence without executing a browser tool', async () => {
  const { bridge, calls, ports, presenceClears, pendingApprovalCancels } = fixture()
  bridge.connect()

  ports[0].onMessage.emit({
    version: BROWSER_BRIDGE_PROTOCOL_VERSION,
    id: 'turn-complete-1',
    kind: 'turnComplete',
    payload: {},
  })
  await tick()

  assert.equal(calls.length, 0)
  assert.equal(pendingApprovalCancels.length, 1)
  assert.equal(presenceClears.length, 1)
  assert.equal(ports[0].posted[0].kind, 'turnCompleteAck')
  assert.equal(ports[0].posted[0].id, 'turn-complete-1')
})

test('turn completion cancels a pending native approval before clearing presence', async () => {
  let resolveApproval
  let approvalRequested
  const approvalStarted = new Promise((resolve) => {
    approvalRequested = resolve
  })
  const { bridge, calls, ports, presenceClears, pendingApprovalCancels } = fixture({
    approvalUiFactory: () => ({
      request: () => {
        approvalRequested()
        return new Promise((resolve) => {
          resolveApproval = resolve
        })
      },
    }),
    executeWithApproval: async (toolCall, _contextFactory, approvalUi) => {
      calls.push(toolCall)
      const decision = await approvalUi.request({ toolCall, policy: { needsApproval: true } })
      return { ok: decision === 'once', error: decision, toolCall }
    },
    cancelPendingApprovals: () => {
      pendingApprovalCancels.push(true)
      resolveApproval?.('cancelled')
    },
  })
  bridge.connect()

  ports[0].onMessage.emit(validRequest('pending-native-approval'))
  await approvalStarted
  ports[0].onMessage.emit({
    version: BROWSER_BRIDGE_PROTOCOL_VERSION,
    id: 'turn-complete-after-pending-approval',
    kind: 'turnComplete',
    payload: {},
  })
  await tick()
  await tick()

  assert.equal(pendingApprovalCancels.length, 1)
  assert.equal(presenceClears.length, 1)
  assert.equal(calls.length, 1)
  assert.ok(ports[0].posted.some((message) => message.kind === 'turnCompleteAck'))
})

test('unknown control messages do not disconnect the bridge before later tool requests', async () => {
  const { bridge, calls, ports } = fixture()
  bridge.connect()

  ports[0].onMessage.emit({
    version: BROWSER_BRIDGE_PROTOCOL_VERSION,
    id: 'unknown-control-1',
    kind: 'futureControl',
    payload: {},
  })
  await tick()

  assert.equal(ports[0].disconnected, false)
  assert.equal(ports[0].posted[0].kind, 'error')
  assert.equal(ports[0].posted[0].payload.code, 'malformed_envelope')

  ports[0].onMessage.emit(validRequest('after-unknown-control'))
  await tick()

  assert.equal(calls.length, 1)
  assert.equal(ports[0].posted[1].kind, 'toolResponse')
  assert.equal(ports[0].posted[1].id, 'after-unknown-control')
})

test('extension protocol contracts stay pinned at version 1', async () => {
  assert.equal(BROWSER_BRIDGE_PROTOCOL_VERSION, 1)
  const nativeMessagingSource = await readFile(
    new URL('../controller/nativeMessaging.ts', import.meta.url),
    'utf8',
  )
  assert.match(nativeMessagingSource, /BROWSER_BRIDGE_PROTOCOL_VERSION = 1 as const/)
})

test('protocol mismatches and malformed envelopes execute nothing', async () => {
  const { bridge, calls, ports } = fixture()
  bridge.connect()

  ports[0].onMessage.emit({ ...validRequest('version'), version: 99 })
  ports[0].onMessage.emit({
    version: BROWSER_BRIDGE_PROTOCOL_VERSION,
    kind: 'toolRequest',
    payload: null,
  })
  await tick()

  assert.equal(calls.length, 0)
  assert.deepEqual(
    ports[0].posted.map((message) => message.payload.code),
    ['protocol_version_mismatch', 'malformed_envelope'],
  )
})

test('approval-required calls fail closed while the panel is unavailable', async () => {
  const { bridge, ports } = fixture({ requireApproval: true, approvalUiAvailable: false })
  bridge.connect()

  ports[0].onMessage.emit(validRequest('approval'))
  await tick()

  assert.equal(ports[0].posted[0].kind, 'error')
  assert.equal(ports[0].posted[0].payload.code, 'approval_ui_unavailable')
})

test('startup connects and every disconnect schedules another attempt', async () => {
  // The host only exists once the desktop app configures the integration, so
  // an extension installed first must keep retrying instead of giving up.
  const { bridge, chromeApi, ports } = fixture()
  bridge.registerStartup()

  chromeApi.runtime.onStartup.emit()
  assert.equal(ports.length, 1)
  ports[0].onDisconnect.emit()
  await tick()
  assert.equal(ports.length, 2)
  ports[1].onDisconnect.emit()
  await tick()
  assert.equal(ports.length, 3)
  ports[2].onDisconnect.emit()
  await tick()
  assert.equal(ports.length, 4)
})

test('an explicit disconnect stops the retry loop', async () => {
  const { bridge, ports } = fixture()
  bridge.connect()
  assert.equal(ports.length, 1)

  bridge.disconnect()
  ports[0].onDisconnect.emit()
  await tick()

  assert.equal(ports.length, 1)
})

test('native host disconnect cancels native approvals and clears presence', async () => {
  const { bridge, ports, presenceClears, pendingApprovalCancels } = fixture()
  bridge.connect()

  ports[0].onDisconnect.emit()
  await tick()

  assert.equal(pendingApprovalCancels.length, 1)
  assert.equal(presenceClears.length, 1)
})

test('a disconnected in-flight request is never replayed onto a new port', async () => {
  let finish
  const { bridge, ports } = fixture({
    executeWithApproval: () => new Promise((resolve) => {
      finish = resolve
    }),
  })
  bridge.connect()
  ports[0].onMessage.emit(validRequest('in-flight'))
  await tick()

  ports[0].onDisconnect.emit()
  await tick()
  finish({ ok: true, result: { late: true } })
  await tick()

  assert.equal(ports.length, 2)
  assert.deepEqual(ports[0].posted, [])
  assert.deepEqual(ports[1].posted, [])
})
