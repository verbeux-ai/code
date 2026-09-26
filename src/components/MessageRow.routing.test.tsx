import { expect, test } from 'bun:test'
import React from 'react'
import { buildMessageLookups } from '../utils/messages.js'
import { routingModelHeaderOwners } from '../utils/routingModelHeaders.js'
import { renderToString } from '../utils/staticRender.js'
import { MessageRow } from './MessageRow.js'

test('a hidden thinking row leaves no routing header or metadata margin', async () => {
  const messages = ['thinking', 'text'].map(type => ({
    type: 'assistant', uuid: `block-${type}`, requestId: 'one-request',
    message: { id: 'one-completion', model: 'ultra/jev-router', metadata: { selected_model: 'glm-5.3' }, content: type === 'thinking' ? [{ type, thinking: 'internal', signature: '' }] : [{ type, text: 'Oi!' }] },
  }))
  const owners = routingModelHeaderOwners(messages)
  const props = {
    isUserContinuation: false, hasContentAfter: false, tools: [], commands: [], verbose: false,
    inProgressToolUseIDs: new Set<string>(), streamingToolUseIDs: new Set<string>(),
    screen: 'prompt', canAnimate: false, lastThinkingBlockId: null, latestBashOutputUUID: null,
    columns: 100, isLoading: false, lookups: buildMessageLookups(messages, messages),
  }
  const hidden = await renderToString(<MessageRow {...props} message={messages[0]} showRoutingModel={false} />, 100)
  expect(hidden.trim()).toBe('')
  const rendered = await renderToString(<>{messages.map(message =>
    <MessageRow key={message.uuid} {...props} message={message} showRoutingModel={owners.has(message.uuid)} />,
  )}</>, 100)
  expect(rendered.match(/ultra\/jev-router → glm-5\.3/g)?.length).toBe(1)
  expect(rendered).toContain('Oi!')
})
