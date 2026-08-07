/**
 * routerClient.test.js — tests for parseCompletionResponse.
 * Run: node --test src/agent/routerClient.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatCompletion, parseCompletionResponse } from './routerClient.js'

test('parseCompletionResponse: standard OpenAI shape with text only', () => {
  const res = parseCompletionResponse({
    choices: [{ message: { role: 'assistant', content: 'Hello!' } }],
  })
  assert.equal(res.content, 'Hello!')
  assert.deepEqual(res.toolCalls, [])
})

test('parseCompletionResponse: standard shape with tool_calls', () => {
  const res = parseCompletionResponse({
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            function: { name: 'navigate', arguments: '{"url":"https://x.com"}' },
          },
        ],
      },
    }],
  })
  assert.equal(res.content, null)
  assert.equal(res.toolCalls.length, 1)
  assert.equal(res.toolCalls[0].id, 'call_1')
  assert.equal(res.toolCalls[0].name, 'navigate')
  assert.equal(res.toolCalls[0].arguments, '{"url":"https://x.com"}')
})

test('parseCompletionResponse: multiple tool_calls', () => {
  const res = parseCompletionResponse({
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', function: { name: 'navigate', arguments: '{"url":"https://a.com"}' } },
          { id: 'c2', function: { name: 'read_page', arguments: '{"selector":"body"}' } },
        ],
      },
    }],
  })
  assert.equal(res.toolCalls.length, 2)
  assert.equal(res.toolCalls[0].name, 'navigate')
  assert.equal(res.toolCalls[1].name, 'read_page')
})

test('parseCompletionResponse: generates fallback id when id missing', () => {
  const res = parseCompletionResponse({
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { function: { name: 'screenshot', arguments: '{}' } },
        ],
      },
    }],
  })
  assert.match(res.toolCalls[0].id, /^tc_/)
})

test('parseCompletionResponse: skips tool_calls with missing function', () => {
  const res = parseCompletionResponse({
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', function: { name: 'navigate', arguments: '{}' } },
          { id: 'c2', function: null },
          { id: 'c3', no_function: true },
        ],
      },
    }],
  })
  assert.equal(res.toolCalls.length, 1)
  assert.equal(res.toolCalls[0].id, 'c1')
})

test('parseCompletionResponse: null content with no tool_calls is valid', () => {
  const res = parseCompletionResponse({
    choices: [{ message: { role: 'assistant', content: null } }],
  })
  assert.equal(res.content, null)
  assert.deepEqual(res.toolCalls, [])
})

test('parseCompletionResponse: throws on empty choices', () => {
  assert.throws(() => parseCompletionResponse({ choices: [] }), /No choices/)
})

test('parseCompletionResponse: throws on null input', () => {
  assert.throws(() => parseCompletionResponse(null), /unreadable/)
})

test('parseCompletionResponse: handles flat message shape (some routers)', () => {
  const res = parseCompletionResponse({
    message: { role: 'assistant', content: 'flat response' },
  })
  assert.equal(res.content, 'flat response')
  assert.deepEqual(res.toolCalls, [])
})

test('parseCompletionResponse: normalizes browser XML tool calls instead of exposing markup', () => {
  const res = parseCompletionResponse({
    choices: [{
      message: {
        role: 'assistant',
        content: '<tool_call><function=browser><parameter=action>navigate</parameter><parameter=url>https://example.com</parameter></tool_call>',
      },
    }],
  }, { allowTextToolCalls: true })

  assert.equal(res.content, null)
  assert.equal(res.toolCalls.length, 1)
  assert.equal(res.toolCalls[0].name, 'navigate')
  assert.deepEqual(JSON.parse(res.toolCalls[0].arguments), { url: 'https://example.com' })
})

test('parseCompletionResponse: normalizes MiniMax invoke tool markup shown by the extension', () => {
  const res = parseCompletionResponse({
    choices: [{
      message: {
        role: 'assistant',
        content: [
          'Vou abrir diretamente. 🚀',
          '<minimax:tool_call>',
          '<invoke name="browser_navigate">',
          '<parameter name="url">https://www.reddit.com</parameter>',
          '</invoke>',
          '</minimax:tool_call>',
        ].join('\n'),
      },
    }],
  }, { allowTextToolCalls: true })

  assert.equal(res.content, 'Vou abrir diretamente. 🚀')
  assert.equal(res.toolCalls.length, 1)
  assert.equal(res.toolCalls[0].name, 'navigate')
  assert.deepEqual(JSON.parse(res.toolCalls[0].arguments), {
    url: 'https://www.reddit.com',
  })
})

test('parseCompletionResponse: normalizes Anthropic tool_use content', () => {
  const res = parseCompletionResponse({
    choices: [{
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect it.' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_page', input: { selector: 'h1' } },
        ],
      },
    }],
  })

  assert.equal(res.content, 'I will inspect it.')
  assert.deepEqual(res.toolCalls, [
    { id: 'toolu_1', name: 'read_page', arguments: '{"selector":"h1"}' },
  ])
})

test('chatCompletion retries one unauthorized request with a refreshed access token', async () => {
  const originalFetch = globalThis.fetch
  const authorizations = []
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    authorizations.push(init.headers.Authorization)
    calls += 1
    if (calls === 1) {
      return { ok: false, status: 401, text: async () => 'expired' }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    }
  }
  try {
    const result = await chatCompletion({
      accessToken: 'old-token',
      model: 'model',
      messages: [{ role: 'user', content: 'hello' }],
      refreshAccessToken: async () => 'new-token',
    })
    assert.equal(result.content, 'ok')
    assert.deepEqual(authorizations, ['Bearer old-token', 'Bearer new-token'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('chatCompletion accepts a complete OpenAI response delivered as SSE', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response([
    'data: {"choices":[{"message":{"role":"assistant","content":"Tudo certo."}}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n'), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
  try {
    const result = await chatCompletion({
      accessToken: 'token',
      model: 'visual-model',
      messages: [{ role: 'user', content: 'teste' }],
    })
    assert.equal(result.content, 'Tudo certo.')
    assert.deepEqual(result.toolCalls, [])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('chatCompletion assembles streamed tool-call argument fragments', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"navigate","arguments":"{\\"url\\":\\"https://"}}]}}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"example.com\\"}"}}]}}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n'), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
  try {
    const result = await chatCompletion({
      accessToken: 'token',
      model: 'visual-model',
      messages: [{ role: 'user', content: 'abra o exemplo' }],
      tools: [{ type: 'function', function: { name: 'navigate' } }],
    })
    assert.deepEqual(result.toolCalls, [{
      id: 'call_1',
      name: 'navigate',
      arguments: '{"url":"https://example.com"}',
    }])
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ────────────────────────────────────────────────────────────────────
// A2-CHROME: parser regression tests for the user-reported leak
//
// Symptom (user, Windows): when the model emits a tool call as text
// (e.g. `<tool_call>...<function=computer>...<parameter=action>screenshot</parameter>...`),
// the parser either failed to resolve the tool name (function was
// `computer` not `browser`) or skipped the entire XML block (because
// the turn offered no tools, the old `allowTextToolCalls` gate skipped
// it). Both modes left the raw `<tool_call>` markup visible to the
// user as plain conversation text.
//
// These tests lock in the parser's behavior:
//  - family wrappers `browser` / `computer` with `parameter=action=<x>`
//    unwrap to the inner tool name
//  - dotted forms `browser.<x>` / `computer.<x>` resolve when `<x>`
//    matches a real tool; invalid suffixes are dropped silently
//  - raw `<tool_call>` markup is ALWAYS stripped from returned content,
//    whether or not structured calls were extracted
//  - malformed XML markup with no extractable calls still produces zero
//    leak (no `<tool_call` substring survives in content)
// ────────────────────────────────────────────────────────────────────

test('parseCompletionResponse: function=computer + action=screenshot unwraps to screenshot tool', () => {
  const json = {
    choices: [{
      message: {
        role: 'assistant',
        content: 'Vou tirar um screenshot pra você.\n<tool_call>\n<function=computer>\n<parameter=action>screenshot</parameter>\n</function>\n</tool_call>',
      },
    }],
  }
  const result = parseCompletionResponse(json)
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].name, 'screenshot')
  assert.equal(result.toolCalls[0].arguments, '{}')
  // Markup MUST NOT appear in content — that was the user-facing bug.
  assert.ok(!(result.content ?? '').includes('<tool_call'))
  assert.ok(!(result.content ?? '').includes('<function='))
  assert.ok((result.content ?? '').includes('Vou tirar um screenshot pra você.'))
})

test('parseCompletionResponse: dotted computer.navigate and computer.click resolve to inner tools', () => {
  const json = {
    choices: [{
      message: {
        role: 'assistant',
        content: '<tool_call>\n<function=computer.navigate>\n<parameter=url>https://example.com</parameter>\n</function>\n</tool_call>',
      },
    }],
  }
  const navigate = parseCompletionResponse(json)
  assert.equal(navigate.toolCalls.length, 1)
  assert.equal(navigate.toolCalls[0].name, 'navigate')
  assert.deepEqual(JSON.parse(navigate.toolCalls[0].arguments), { url: 'https://example.com' })
  assert.ok(!(navigate.content ?? '').includes('<tool_call'))

  // `computer.click` — a real tool, dotted form. The user's capture
  // showed models emitting `computer.navigate` and `computer.wait`;
  // `wait` is NOT a real tool (it's a hallucination) and is covered
  // by the "unknown suffix dropped" test below. Here we use `click`
  // which IS a real tool.
  const jsonClick = {
    choices: [{
      message: {
        role: 'assistant',
        content: '<tool_call>\n<function=computer.click>\n<parameter=selector>#submit</parameter>\n</function>\n</tool_call>',
      },
    }],
  }
  const click = parseCompletionResponse(jsonClick)
  assert.equal(click.toolCalls.length, 1)
  assert.equal(click.toolCalls[0].name, 'click')
  assert.deepEqual(JSON.parse(click.toolCalls[0].arguments), { selector: '#submit' })
})

test('parseCompletionResponse: dotted form with unknown suffix is dropped, markup is still stripped', () => {
  const json = {
    choices: [{
      message: {
        role: 'assistant',
        content: '<tool_call>\n<function=computer.totally_made_up>\n<parameter=foo>bar</parameter>\n</function>\n</tool_call>some prose after',
      },
    }],
  }
  const result = parseCompletionResponse(json)
  // Unknown tool suffix — drop the call rather than pass a fake name through.
  assert.equal(result.toolCalls.length, 0)
  // BUT the markup is still stripped from the content the user sees.
  assert.ok(!(result.content ?? '').includes('<tool_call'))
  assert.ok(!(result.content ?? '').includes('<function='))
  assert.ok((result.content ?? '').includes('some prose after'))
})

test('parseCompletionResponse: raw tool_call markup NEVER survives in content for any family', () => {
  // Five flavours of the user's symptom — none should leak markup.
  const flavours = [
    { content: 'before\n<tool_call>\n<function=computer>\n<parameter=action>screenshot</parameter>\n</function>\n</tool_call>\nafter' },
    { content: 'x<tool_call><function=browser.navigate><parameter=url>https://e.com</parameter></function></tool_call>y' },
    { content: 'a<tool_call><function=browser_click><parameter=selector>#btn</parameter></function></tool_call>b' },
    { content: '<tool_call><function=garbage_tool></function></tool_call>plain text' },
    { content: 'no markup here' },
  ]
  for (const { content } of flavours) {
    const result = parseCompletionResponse({ choices: [{ message: { role: 'assistant', content } }] })
    assert.ok(
      !(result.content ?? '').includes('<tool_call'),
      `markup leaked in content for input: ${JSON.stringify(content)} → ${JSON.stringify(result.content)}`,
    )
    assert.ok(
      !(result.content ?? '').includes('</tool_call>'),
      `closing markup leaked in content for input: ${JSON.stringify(content)}`,
    )
  }
})

test('parseCompletionResponse: malformed markup with zero extractable calls returns clean content, no throw', () => {
  // The OLD parser threw `Router returned a malformed text tool call`
  // here. The NEW parser silently strips the markup — the agent loop is
  // responsible for surfacing "tools weren't available" to the user,
  // not the parser. A throw here would leave the panel stuck on
  // "Working…" because nothing got returned.
  const json = {
    choices: [{
      message: {
        role: 'assistant',
        content: 'Half a tool call: <tool_call>not a real call',
      },
    }],
  }
  const result = parseCompletionResponse(json)
  assert.equal(result.toolCalls.length, 0)
  assert.equal(result.content, 'Half a tool call: not a real call')
})

// ────────────────────────────────────────────────────────────────────
// A2-CHROME Correction 1: no double-execution when structured + text
// mirror the same call.
//
// The parser must ALWAYS strip the markup (presentation fix), but only
// FORWARD the parsed text calls when there are no structured tool_calls.
// Otherwise a model that emits a structured `type` call AND mirrors
// `<tool_call><function=type>...` in content would produce two calls, and
// loop.js's dedupeToolCalls does NOT save us (it keys on name +
// canonical arguments, and the text form's arguments differ from the
// structured form's — so both survive dedupe and `type` runs twice).
// ────────────────────────────────────────────────────────────────────

test('parseCompletionResponse: structured tool_call + text mirror = ONE call, content clean', () => {
  const json = {
    choices: [{
      message: {
        role: 'assistant',
        content: [
          'Vou digitar pra voce.',
          '<tool_call>',
          '<function=type>',
          '<parameter=text>ola</parameter>',
          '<parameter=selector>#campo</parameter>',
          '</function>',
          '</tool_call>',
        ].join('\n'),
        tool_calls: [{
          id: 'call_structured_1',
          type: 'function',
          function: {
            name: 'type',
            arguments: JSON.stringify({ text: 'ola', selector: '#campo' }),
          },
        }],
      },
    }],
  }
  const result = parseCompletionResponse(json)
  // ONE call, not two — the structured one wins, the text mirror is dropped.
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].name, 'type')
  assert.equal(result.toolCalls[0].id, 'call_structured_1')
  // Markup is STILL stripped from content (presentation fix is unconditional).
  assert.ok(!(result.content ?? '').includes('<tool_call'))
  assert.ok(!(result.content ?? '').includes('<function='))
  assert.ok((result.content ?? '').includes('Vou digitar pra voce.'))
})

// Counterfactual: text-only (no structured tool_calls) still parses normally.
test('parseCompletionResponse: text-only tool call (no structured) parses normally', () => {
  const json = {
    choices: [{
      message: {
        role: 'assistant',
        content: [
          '<tool_call>',
          '<function=type>',
          '<parameter=text>ola</parameter>',
          '<parameter=selector>#campo</parameter>',
          '</function>',
          '</tool_call>',
        ].join('\n'),
      },
    }],
  }
  const result = parseCompletionResponse(json)
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].name, 'type')
  assert.deepEqual(JSON.parse(result.toolCalls[0].arguments), { text: 'ola', selector: '#campo' })
  assert.ok(!(result.content ?? '').includes('<tool_call'))
})

test('parseCompletionResponse: text-only structured extraction call parses normally', () => {
  const result = parseCompletionResponse({
    choices: [{
      message: {
        role: 'assistant',
        content: [
          'Vou estruturar os dados.',
          '<tool_call>',
          '<function=structured_extract>',
          '<parameter=format>csv</parameter>',
          '<parameter=selector>table</parameter>',
          '</function>',
          '</tool_call>',
        ].join('\n'),
      },
    }],
  })
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].name, 'structured_extract')
  assert.deepEqual(JSON.parse(result.toolCalls[0].arguments), {
    format: 'csv',
    selector: 'table',
  })
  assert.equal(result.content, 'Vou estruturar os dados.')
})

test('parseCompletionResponse: JSON computer tool calls inside tool_call markup are normalized', () => {
  const result = parseCompletionResponse({
    choices: [{
      message: {
        role: 'assistant',
        content: [
          'Vou abrir a página.',
          '<tool_call>',
          '{"name":"computer.navigate","arguments":{"url":"https://github.com"}}',
          '</tool_call>',
        ].join('\n'),
      },
    }],
  })

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].name, 'navigate')
  assert.deepEqual(JSON.parse(result.toolCalls[0].arguments), {
    url: 'https://github.com',
  })
  assert.equal(result.content, 'Vou abrir a página.')
})

test('parseCompletionResponse: JSON computer action unwraps action and drops unknown tools', () => {
  const result = parseCompletionResponse({
    choices: [{
      message: {
        content: [
          '<tool_call>',
          '{"name":"computer","arguments":{"action":"read_page","selector":"body"}}',
          '</tool_call>',
          '<tool_call>',
          '{"name":"computer.wait","arguments":{"seconds":2}}',
          '</tool_call>',
        ].join('\n'),
      },
    }],
  })

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].name, 'read_page')
  assert.deepEqual(JSON.parse(result.toolCalls[0].arguments), { selector: 'body' })
  assert.ok(!(result.content ?? '').includes('<tool_call'))
})
