export type BoundedResponseBodyFailure =
  | 'invalid_json'
  | 'invalid_utf8'
  | 'too_large'
  | 'unreadable'

export class BoundedResponseBodyError extends Error {
  readonly failure: BoundedResponseBodyFailure

  constructor(failure: BoundedResponseBodyFailure, message: string) {
    super(message)
    this.name = 'BoundedResponseBodyError'
    this.failure = failure
  }
}

async function cancelBody(
  body: ReadableStream<Uint8Array> | null,
  reason: unknown,
): Promise<void> {
  if (!body) return
  await body.cancel(reason).catch(() => undefined)
}

function declaredBodyLength(response: Response): number | undefined {
  const raw = response.headers.get('content-length')?.trim()
  if (!raw || !/^\d+$/.test(raw)) return undefined
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/**
 * Consume an HTTP response without allowing a direct-provider response to
 * grow the CLI heap without bound. UTF-8 is decoded strictly so replacement
 * glyphs can never hide a corrupt provider payload.
 */
export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('maxBytes must be a positive safe integer')
  }

  const declared = declaredBodyLength(response)
  if (declared !== undefined && declared > maxBytes) {
    const error = new BoundedResponseBodyError(
      'too_large',
      `HTTP response body exceeded the ${maxBytes}-byte safety limit`,
    )
    await cancelBody(response.body, error)
    throw error
  }

  const body = response.body
  if (!body) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let totalBytes = 0
  let text = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        const error = new BoundedResponseBodyError(
          'too_large',
          `HTTP response body exceeded the ${maxBytes}-byte safety limit`,
        )
        await reader.cancel(error).catch(() => undefined)
        throw error
      }
      try {
        text += decoder.decode(value, { stream: true })
      } catch {
        const error = new BoundedResponseBodyError(
          'invalid_utf8',
          'HTTP response body contained invalid UTF-8',
        )
        await reader.cancel(error).catch(() => undefined)
        throw error
      }
    }
    try {
      text += decoder.decode()
    } catch {
      throw new BoundedResponseBodyError(
        'invalid_utf8',
        'HTTP response body contained incomplete UTF-8',
      )
    }
    return text
  } catch (error) {
    if (error instanceof BoundedResponseBodyError) throw error
    throw new BoundedResponseBodyError(
      'unreadable',
      `HTTP response body could not be read: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // The stream may already be errored or cancelled.
    }
  }
}

export async function readBoundedResponseJson<T>(
  response: Response,
  maxBytes: number,
): Promise<T> {
  const text = await readBoundedResponseText(response, maxBytes)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new BoundedResponseBodyError(
      'invalid_json',
      'HTTP response body contained invalid JSON',
    )
  }
}

export async function drainBoundedResponseBody(
  response: Response,
  maxBytes: number,
): Promise<void> {
  await readBoundedResponseText(response, maxBytes).then(
    () => undefined,
    () => undefined,
  )
}
