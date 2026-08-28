import { describe, expect, test } from 'bun:test'

import {
  BoundedResponseBodyError,
  readBoundedResponseJson,
  readBoundedResponseText,
} from './boundedResponseBody.js'

describe('bounded response bodies', () => {
  test('reads a split UTF-8 scalar strictly', async () => {
    const bytes = new TextEncoder().encode('ok ✅')
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, bytes.length - 1))
          controller.enqueue(bytes.slice(bytes.length - 1))
          controller.close()
        },
      }),
    )

    expect(await readBoundedResponseText(response, 32)).toBe('ok ✅')
  })

  test('rejects a declared oversize body before reading it', async () => {
    const response = new Response('ignored', {
      headers: { 'content-length': '33' },
    })

    await expect(readBoundedResponseText(response, 32)).rejects.toMatchObject({
      failure: 'too_large',
    })
  })

  test('rejects a chunked body once it crosses the bound', async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(20))
          controller.enqueue(new Uint8Array(20))
        },
      }),
    )

    await expect(readBoundedResponseText(response, 32)).rejects.toMatchObject({
      failure: 'too_large',
    })
  })

  test('rejects invalid UTF-8 instead of rendering replacement glyphs', async () => {
    const response = new Response(new Uint8Array([0x66, 0x80, 0x6f]))

    await expect(readBoundedResponseText(response, 32)).rejects.toMatchObject({
      failure: 'invalid_utf8',
    })
  })

  test('separates JSON parsing failures from transport decoding', async () => {
    try {
      await readBoundedResponseJson(new Response('{broken'), 32)
      throw new Error('expected invalid JSON to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(BoundedResponseBodyError)
      expect((error as BoundedResponseBodyError).failure).toBe('invalid_json')
    }
  })
})
