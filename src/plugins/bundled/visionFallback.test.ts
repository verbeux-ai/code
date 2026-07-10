import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { registerVisionFallbackPlugin } from './vision-fallback/index.js'
import { getBuiltinPluginDefinition } from '../builtinPlugins.js'
import { describeAttachments } from './vision-fallback/runtime.js'

describe('vision-fallback bundled plugin', () => {
  beforeEach(() => {
    registerVisionFallbackPlugin()
  })

  it('registers a builtin plugin named vision-fallback', () => {
    const definition = getBuiltinPluginDefinition('vision-fallback')
    expect(definition).toBeDefined()
    expect(definition!.name).toBe('vision-fallback')
    expect(definition!.defaultEnabled).toBe(true)
  })

  it('registers a UserPromptSubmit command hook', () => {
    const definition = getBuiltinPluginDefinition('vision-fallback')
    const matchers = definition!.hooks?.UserPromptSubmit
    expect(matchers).toBeDefined()
    expect(matchers).toHaveLength(1)
    const hook = matchers![0].hooks[0]
    expect(hook.type).toBe('command')
    expect(hook.timeout).toBe(60)
    expect(hook.statusMessage).toBe('Analyzing image with vision fallback...')
  })
})

describe('vision-fallback runtime', () => {
  const originalFetch = globalThis.fetch
  const originalVisionApiKey = process.env.VISION_API_KEY
  const originalPrimaryModel = process.env.VERBOO_VISION_PRIMARY_MODEL
  const originalFallbackModel = process.env.VERBOO_VISION_FALLBACK_MODEL
  const originalBaseUrl = process.env.VERBOO_VISION_BASE_URL

  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env.VISION_API_KEY = originalVisionApiKey
    process.env.VERBOO_VISION_PRIMARY_MODEL = originalPrimaryModel
    process.env.VERBOO_VISION_FALLBACK_MODEL = originalFallbackModel
    process.env.VERBOO_VISION_BASE_URL = originalBaseUrl
  })

  it('no-op when there are no attachments', async () => {
    const result = await describeAttachments({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'hello',
      cwd: 'C:/tmp/vision-fallback-test-cwd',
    })
    expect(result.additionalContext).toBeUndefined()
  })

  it('returns warning when API key is missing', async () => {
    const result = await describeAttachments(
      {
        hook_event_name: 'UserPromptSubmit',
        prompt: '[Image #1]',
        cwd: 'C:/tmp/vision-fallback-test-cwd',
        attachments: [
          {
            type: 'image',
            source: 'base64',
            mediaType: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          },
        ],
      },
      '',
    )
    expect(result.additionalContext).toContain('credencial do router não encontrada')
  })

  it('describes image using primary model', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Um cachorro marrom.' } }],
        }),
        { status: 200 },
      ) as unknown as Response

    const result = await describeAttachments(
      {
        hook_event_name: 'UserPromptSubmit',
        prompt: '[Image #1]',
        cwd: 'C:/tmp/vision-fallback-test-cwd',
        attachments: [
          {
            type: 'image',
            source: 'base64',
            mediaType: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          },
        ],
      },
      'test-key',
    )
    expect(result.additionalContext).toBe('Um cachorro marrom.')
  })

  it('falls back to secondary model when primary fails', async () => {
    process.env.VERBOO_VISION_PRIMARY_MODEL = 'ultra/failing-model'
    process.env.VERBOO_VISION_FALLBACK_MODEL = 'ultra/kimi-k2.7'

    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse((init as { body: string }).body)
      if (body.model === 'ultra/failing-model') {
        return new Response('Internal Server Error', { status: 500 }) as unknown as Response
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Fallback description.' } }],
        }),
        { status: 200 },
      ) as unknown as Response
    }

    const result = await describeAttachments(
      {
        hook_event_name: 'UserPromptSubmit',
        prompt: '[Image #1]',
        cwd: 'C:/tmp/vision-fallback-test-cwd',
        attachments: [
          {
            type: 'image',
            source: 'base64',
            mediaType: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          },
        ],
      },
      'test-key',
    )
    expect(result.additionalContext).toBe('Fallback description.')
  })
})
