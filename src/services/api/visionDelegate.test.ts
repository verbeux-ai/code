import { beforeEach, expect, test } from 'bun:test'
import {
  clearVisionAnalysisCache,
  delegateImagesInMessages,
  IMAGE_REMOVED_PLACEHOLDER,
  isVisionDelegationEnabled,
  messagesContainImages,
  modelSupportsVision,
  stripResidualImageParts,
  visionAnalysisMarker,
  type VisionCaller,
} from './visionDelegate.ts'

beforeEach(() => {
  clearVisionAnalysisCache()
  delete process.env.VERBOO_VISION_DELEGATE
})

function imageBlock(data = 'aGVsbG8='): Record<string, unknown> {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data },
  }
}

// --- gate ---------------------------------------------------------------

test('delegation is enabled by default and disabled via env', () => {
  expect(isVisionDelegationEnabled()).toBe(true)
  process.env.VERBOO_VISION_DELEGATE = 'off'
  expect(isVisionDelegationEnabled()).toBe(false)
})

// --- modelSupportsVision --------------------------------------------------

test('deepseek models never receive images', () => {
  expect(modelSupportsVision('deepseek-chat')).toBe(false)
  expect(modelSupportsVision('deepseek-v4-flash')).toBe(false)
})

test('qwen vision models are recognized, including router-prefixed ids', () => {
  expect(modelSupportsVision('qwen3.6-27b')).toBe(true)
  expect(modelSupportsVision('qwen3.5-vl')).toBe(true)
})

test('coder ids without a registry descriptor fall to the non-vision hint', () => {
  // Registry descriptors always win (e.g. qwen3-coder-plus is registered with
  // supportsVision: true and stays true); the id heuristic only applies to
  // unknown ids, where "coder" beats the "qwen"-style vision hints.
  expect(modelSupportsVision('mystery-coder-9000')).toBe(false)
})

test('unknown models default to no vision (delegating is the safe side)', () => {
  expect(modelSupportsVision('mystery-model-9000')).toBe(false)
  expect(modelSupportsVision('')).toBe(false)
})

// --- messagesContainImages --------------------------------------------------

test('detects images in user messages and nested tool_results', () => {
  expect(
    messagesContainImages([{ role: 'user', content: 'just text' }]),
  ).toBe(false)
  expect(
    messagesContainImages([{ role: 'user', content: [imageBlock()] }]),
  ).toBe(true)
  expect(
    messagesContainImages([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: [imageBlock()] },
        ],
      },
    ]),
  ).toBe(true)
})

// --- delegateImagesInMessages -------------------------------------------------

function makeCaller(analysis = 'a red rectangle with TESTE text') {
  const calls: Array<{ model: string; prompt: string; images: unknown[] }> = []
  const caller: VisionCaller = async args => {
    calls.push(args)
    return analysis
  }
  return { caller, calls }
}

test('replaces a pasted image with the vision analysis and marker', async () => {
  const { caller, calls } = makeCaller()
  const messages = [
    {
      role: 'user',
      content: [{ type: 'text', text: 'o que há neste print?' }, imageBlock()],
    },
  ]

  const out = await delegateImagesInMessages(messages, 'qwen3.6-27b', caller)

  const content = out[0].content as Array<{ type: string; text?: string }>
  expect(content.some(b => b.type === 'image')).toBe(false)
  const injected = content.find(b => b.text?.includes('red rectangle'))
  expect(injected?.text).toContain(visionAnalysisMarker('qwen3.6-27b'))
  // user text flows into the delegation prompt as context
  expect(calls[0].prompt).toContain('o que há neste print?')
})

test('handles the wrapped .message.content shape', async () => {
  const { caller } = makeCaller()
  const messages = [
    {
      role: 'user',
      message: { role: 'user', content: [imageBlock()] },
    },
  ]
  const out = await delegateImagesInMessages(messages, 'v', caller)
  const content = (out[0].message as { content: Array<{ type: string }> })
    .content
  expect(content.some(b => b.type === 'image')).toBe(false)
})

test('tool_result screenshots are analyzed with the tool name as context', async () => {
  const { caller, calls } = makeCaller()
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'tira um print do site' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu1', name: 'take_screenshot', input: {} }],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: [imageBlock()] },
      ],
    },
  ]

  const out = await delegateImagesInMessages(messages, 'v', caller)

  expect(calls).toHaveLength(1)
  expect(calls[0].prompt).toContain('take_screenshot')
  expect(calls[0].prompt).toContain('tira um print do site')
  const toolResult = (out[2].content as Array<Record<string, unknown>>)[0]
  const nested = toolResult.content as Array<{ type: string; text?: string }>
  expect(nested.some(b => b.type === 'image')).toBe(false)
})

test('multiple images in one tool_result share a single vision call', async () => {
  const { caller, calls } = makeCaller()
  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: [imageBlock('AAA='), imageBlock('BBB=')],
        },
      ],
    },
  ]

  const out = await delegateImagesInMessages(messages, 'v', caller)

  expect(calls).toHaveLength(1)
  expect(calls[0].images).toHaveLength(2)
  const nested = (out[0].content as Array<Record<string, unknown>>)[0]
    .content as Array<{ text?: string }>
  expect(nested[1].text).toContain('combined image analysis')
})

test('the same image across turns is analyzed only once (history resend)', async () => {
  const { caller, calls } = makeCaller()
  const turn = [{ role: 'user', content: [imageBlock('c2FtZQ==')] }]

  await delegateImagesInMessages(turn, 'v', caller)
  await delegateImagesInMessages(turn, 'v', caller) // next turn resends history

  expect(calls).toHaveLength(1)
})

test('a failed vision call degrades to a placeholder and never throws', async () => {
  const caller: VisionCaller = async () => {
    throw new Error('router unavailable')
  }
  const messages = [{ role: 'user', content: [imageBlock()] }]

  const out = await delegateImagesInMessages(messages, 'v', caller)

  const content = out[0].content as Array<{ type: string; text?: string }>
  expect(content[0].type).toBe('text')
  expect(content[0].text).toContain('could not be analyzed')
})

test('messages without images pass through as the same reference', async () => {
  const { caller, calls } = makeCaller()
  const messages = [{ role: 'user', content: 'sem imagem' }]
  const out = await delegateImagesInMessages(messages, 'v', caller)
  expect(out).toBe(messages)
  expect(calls).toHaveLength(0)
})

// --- stripResidualImageParts ---------------------------------------------------

test('strips surviving image_url parts and reports the count', () => {
  const { messages, removed } = stripResidualImageParts([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'oi' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
      ],
    },
  ])
  expect(removed).toBe(1)
  const parts = messages[0].content as Array<{ type: string; text?: string }>
  expect(parts.some(p => p.type === 'image_url')).toBe(false)
  expect(parts[1].text).toBe(IMAGE_REMOVED_PLACEHOLDER)
})

test('is a no-op (same reference) when nothing image-shaped survived', () => {
  const input = [{ role: 'user', content: 'texto' }]
  const { messages, removed } = stripResidualImageParts(input)
  expect(removed).toBe(0)
  expect(messages).toBe(input)
})
