import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import axios from 'axios'

const actualOauth = { ...(await import('../constants/oauth.js')) }
mock.module('../constants/oauth.js', () => ({
  ...actualOauth,
  isVerbooMode: () => true,
}))

type QueryArgs = {
  outputFormat?: unknown
  options: { model?: string }
}
const reply = (text: string) => ({
  message: {
    content: [
      // Reasoning models answer through the shim with a thinking block first.
      { type: 'thinking', thinking: 'Considering a title...' },
      { type: 'text', text },
    ],
  },
})
const queryHaiku = mock(async (_args: QueryArgs): Promise<unknown> => reply(''))
const queryWithModel = mock(async (_args: QueryArgs): Promise<unknown> => reply(''))
const actualClaude = { ...(await import('../services/api/claude.js')) }
mock.module('../services/api/claude.js', () => ({
  ...actualClaude,
  queryHaiku,
  queryWithModel,
}))

const {
  deriveFallbackSessionTitle,
  generateSessionTitle,
  generateSessionTitleWithSource,
  parseSessionTitleResponse,
} = await import('./sessionTitle.js')
const { clearVerbooModelsCache, fetchVerbooModels } = await import(
  '../services/api/verbooModels.js'
)

const originalGet = axios.get
const signal = () => new AbortController().signal

async function seedCatalog(roles?: Record<string, string>): Promise<void> {
  axios.get = mock(async () => ({
    data: {
      data: [{ id: 'ultra/glm-5.3' }, { id: 'ultra/glm-5.3-flash-cheap' }],
      agent_model_roles: roles,
    },
  })) as typeof axios.get
  await fetchVerbooModels('access-token', { force: true })
}

beforeEach(() => {
  queryHaiku.mockReset()
  queryWithModel.mockReset()
})

afterEach(() => {
  axios.get = originalGet
  clearVerbooModelsCache()
})

describe('parseSessionTitleResponse', () => {
  test.each([
    ['{"title": "Fix login button on mobile"}', 'Fix login button on mobile'],
    ['```json\n{"title":"Add OAuth authentication"}\n```', 'Add OAuth authentication'],
    ['Sure! {"title": "Debug failing CI tests"}', 'Debug failing CI tests'],
    ['Fix login button on mobile', 'Fix login button on mobile'],
    ['"Fix login button on mobile."', 'Fix login button on mobile'],
    ['Title: Refactor API client', 'Refactor API client'],
    ['**Refactor API client**', 'Refactor API client'],
    ['# Refactor API client', 'Refactor API client'],
    ['Here is a title:\nCorrigir login no celular', 'Corrigir login no celular'],
    ['<think>reasoning</think>\nAdd dark mode', 'Add dark mode'],
    ['Title-case conversion helper', 'Title-case conversion helper'],
  ])('%j -> %j', (input, expected) => {
    expect(parseSessionTitleResponse(input)).toBe(expected)
  })

  test('returns null for empty replies', () => {
    expect(parseSessionTitleResponse('')).toBeNull()
    expect(parseSessionTitleResponse('  \n ')).toBeNull()
    expect(parseSessionTitleResponse('{"title": ""}')).toBeNull()
  })

  test('caps runaway titles', () => {
    const title = parseSessionTitleResponse('word '.repeat(60))!
    expect(title.length).toBeLessThanOrEqual(80)
    expect(title.endsWith('…')).toBe(true)
  })
})

describe('deriveFallbackSessionTitle', () => {
  test('cleans tags and whitespace from the first prompt and truncates it', () => {
    const title = deriveFallbackSessionTitle(
      '<ide_opened_file>src/app.ts</ide_opened_file>\n  corrija o bug   do login\nquando o usuário erra a senha três vezes seguidas e a tela trava',
    )!
    expect(title.startsWith('corrija o bug do login quando')).toBe(true)
    expect(title).not.toContain('ide_opened_file')
    expect(title.length).toBeLessThanOrEqual(60)
    expect(title.endsWith('…')).toBe(true)
  })

  test('returns null when nothing is left', () => {
    expect(deriveFallbackSessionTitle('<command-name>/clear</command-name>')).toBeNull()
  })
})

describe('generateSessionTitle in Verboo mode', () => {
  test('uses the "fast" role model without structured output', async () => {
    await seedCatalog({ fast: 'ultra/glm-5.3-flash-cheap' })
    queryWithModel.mockImplementation(async () => reply('Fix login button on mobile'))

    const result = await generateSessionTitleWithSource('fix the login button', signal())

    expect(result).toEqual({ title: 'Fix login button on mobile', source: 'model' })
    expect(queryHaiku).not.toHaveBeenCalled()
    const args = queryWithModel.mock.calls[0]![0]
    expect(args.options.model).toBe('ultra/glm-5.3-flash-cheap')
    expect(args.outputFormat).toBeUndefined()
  })

  test('without a fast role keeps the small-fast model, still without output_format', async () => {
    await seedCatalog({})
    queryHaiku.mockImplementation(async () => reply('{"title":"Add OAuth authentication"}'))

    const title = await generateSessionTitle('add oauth', signal())

    expect(title).toBe('Add OAuth authentication')
    expect(queryWithModel).not.toHaveBeenCalled()
    expect(queryHaiku.mock.calls[0]![0].outputFormat).toBeUndefined()
  })

  test('falls back to the cleaned first prompt when the router rejects the call', async () => {
    await seedCatalog({ fast: 'ultra/glm-5.3-flash-cheap' })
    queryWithModel.mockImplementation(async () => {
      throw new Error('403 structured_output_not_enabled')
    })

    const result = await generateSessionTitleWithSource(
      '  corrigir   o deploy do backend\n',
      signal(),
    )

    expect(result).toEqual({ title: 'corrigir o deploy do backend', source: 'fallback' })
    expect(result?.title).not.toBe('Verboo Code')
  })

  test('falls back when the model reply is empty', async () => {
    await seedCatalog({})
    queryHaiku.mockImplementation(async () => reply('   '))
    const result = await generateSessionTitleWithSource('add dark mode', signal())
    expect(result).toEqual({ title: 'add dark mode', source: 'fallback' })
  })

  test('returns null for an empty description', async () => {
    expect(await generateSessionTitle('   ', signal())).toBeNull()
    expect(queryHaiku).not.toHaveBeenCalled()
  })
})
