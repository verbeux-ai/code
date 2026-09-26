import { expect, test } from 'bun:test'
import React from 'react'
import { renderToString } from '../utils/staticRender.js'
import { MessageModel } from './MessageModel.js'
import { routingModelHeaderOwners } from '../utils/routingModelHeaders.js'

test('shows the physical Jev choice during a normal CLI conversation', async () => {
  const message = {
    type: 'assistant',
    message: {
      model: 'jev-router',
      metadata: { selected_model: 'glm-5.3-flash' },
      content: [{ type: 'text', text: 'ok' }],
    },
  }
  const rendered = await renderToString(
    <MessageModel message={message} isTranscriptMode={false} />,
    80,
  )
  expect(rendered).toContain('jev-router → glm-5.3-flash')
})

function assistant(uuid: string, id: string, content: Array<{ type: string; text?: string; thinking?: string }>, requestId = 'request-one') {
  return { type: 'assistant', uuid, requestId, message: { id, model: 'ultra/jev-router', metadata: { selected_model: 'glm-5.3' }, content } }
}

test.each([false, true])('renders one routing header per completion across normalized blocks (transcript=%s)', async isTranscriptMode => {
  const messages = [
    assistant('thinking', 'completion-one', [{ type: 'thinking', thinking: 'internal reasoning' }]),
    assistant('redacted', 'completion-one', [{ type: 'redacted_thinking' }]),
    assistant('blank', 'completion-one', [{ type: 'text', text: '   ' }]),
    assistant('first-text', 'completion-one', [{ type: 'text', text: 'Oi!' }]),
    assistant('second-text', 'completion-one', [{ type: 'text', text: 'Em que posso ajudar?' }]),
    assistant('tool', 'completion-one', [{ type: 'tool_use' }]),
    assistant('next-request', 'completion-two', [{ type: 'text', text: 'Outra resposta' }], 'request-two'),
  ]
  const owners = routingModelHeaderOwners(messages)
  expect([...owners]).toEqual(['first-text', 'next-request'])
  const rendered = await renderToString(<>{messages.map(message =>
    <MessageModel key={message.uuid} message={message} isTranscriptMode={isTranscriptMode} showRoutingModel={owners.has(message.uuid)} />,
  )}</>, 100)
  expect(rendered.match(/ultra\/jev-router → glm-5\.3/g)?.length).toBe(2)
})

test('resumed and grouped tool blocks preserve completion identity', () => {
  const first = assistant('tool-first', 'completion-one', [{ type: 'tool_use' }])
  const later = assistant('tool-later', 'completion-one', [{ type: 'tool_use' }])
  const messages = [
    { type: 'grouped_tool_use', uuid: 'group', displayMessage: first, messages: [first, later] },
    assistant('text-after-tools', 'completion-one', [{ type: 'text', text: 'Done' }]),
    assistant('next', 'completion-two', [{ type: 'text', text: 'Next' }]),
  ]
  expect([...routingModelHeaderOwners(messages)]).toEqual(['group', 'next'])
  expect([...routingModelHeaderOwners(structuredClone(messages))]).toEqual(['group', 'next'])
})

test('equal provider message IDs in independent requests are not deduplicated', () => {
  const messages = [
    assistant('one', 'provider-id', [{ type: 'text', text: 'One' }], 'request-one'),
    assistant('two', 'provider-id', [{ type: 'text', text: 'Two' }], 'request-two'),
  ]
  expect([...routingModelHeaderOwners(messages)]).toEqual(['one', 'two'])
})
