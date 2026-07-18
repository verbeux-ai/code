import { afterEach, expect, mock, test } from 'bun:test'
import axios from 'axios'

import {
  acceptVerbooTerms,
  fetchVerbooTermsStatus,
  getHeadlessTermsRequiredMessage,
  getPublicTermsURL,
  type VerbooTermsStatus,
} from './verbooTerms.js'

const originalGet = axios.get
const originalPost = axios.post

afterEach(() => {
  axios.get = originalGet
  axios.post = originalPost
})

const requiredStatus: VerbooTermsStatus = {
  configured: true,
  current: {
    id: '65bdcfe5-cae7-4978-bacd-c6575b80c852',
    version: 3,
    isCurrent: true,
    title: 'Termos de Uso',
    locale: 'pt',
    availableLocales: ['pt'],
    changeSummary: 'Política atualizada.',
    requiresReacceptance: true,
    enforcementAt: '2026-07-20T12:00:00Z',
    publishedAt: '2026-07-15T12:00:00Z',
  },
  mustAccept: true,
  pendingReacceptance: false,
  acceptUrl: 'https://code.verboo.ai/pt/terms/accept?version=3',
}

test('loads the authenticated terms status without accepting anything', async () => {
  axios.get = mock(async (_url, config) => {
    expect(config?.headers?.Authorization).toBe('Bearer access-token')
    expect(config?.timeout).toBe(10_000)
    return { status: 200, data: { data: requiredStatus } }
  }) as typeof axios.get

  await expect(fetchVerbooTermsStatus('access-token', 'pt')).resolves.toEqual({
    kind: 'ok',
    status: requiredStatus,
  })
})

test('retries a transient terms-status timeout before denying access', async () => {
  let attempts = 0
  axios.get = mock(async () => {
    attempts++
    if (attempts === 1) {
      throw Object.assign(new Error('timeout of 10000ms exceeded'), {
        code: 'ECONNABORTED',
        isAxiosError: true,
      })
    }
    return { status: 200, data: { data: requiredStatus } }
  }) as typeof axios.get

  await expect(fetchVerbooTermsStatus('access-token', 'pt')).resolves.toEqual({
    kind: 'ok',
    status: requiredStatus,
  })
  expect(attempts).toBe(2)
})

test('retries a transient terms-status server response before denying access', async () => {
  let attempts = 0
  axios.get = mock(async () => {
    attempts++
    if (attempts === 1) {
      return { status: 503, data: {} }
    }
    return { status: 200, data: { data: requiredStatus } }
  }) as typeof axios.get

  await expect(fetchVerbooTermsStatus('access-token', 'pt')).resolves.toEqual({
    kind: 'ok',
    status: requiredStatus,
  })
  expect(attempts).toBe(2)
})

test('does not retry an expired or forbidden session', async () => {
  let attempts = 0
  axios.get = mock(async () => {
    attempts++
    return { status: 401, data: {} }
  }) as typeof axios.get

  await expect(fetchVerbooTermsStatus('access-token', 'pt')).resolves.toEqual({
    kind: 'unauthorized',
  })
  expect(attempts).toBe(1)
})

test('accepts only through an explicit accepted=true request', async () => {
  axios.post = mock(async (_url, body) => {
    expect(body).toEqual({
      versionId: requiredStatus.current?.id,
      locale: 'pt',
      accepted: true,
    })
    return {
      status: 200,
      data: {
        data: {
          id: 'acceptance-id',
          termsVersionId: requiredStatus.current?.id,
          acceptedAt: '2026-07-15T12:30:00Z',
          contentLocale: 'pt',
          contentSha256: 'hash',
          channel: 'cli',
          requestId: 'request-id',
        },
      },
    }
  }) as typeof axios.post

  const acceptance = await acceptVerbooTerms(
    'access-token',
    requiredStatus.current!.id,
    'pt',
  )
  expect(acceptance.channel).toBe('cli')
  expect(acceptance.acceptedAt).toBe('2026-07-15T12:30:00Z')
})

test('builds a public version URL and a strict headless refusal', () => {
  expect(getPublicTermsURL(requiredStatus)).toBe(
    'https://code.verboo.ai/pt/terms?version=3',
  )
  const message = getHeadlessTermsRequiredMessage(requiredStatus)
  expect(message).toContain('versão 3')
  expect(message).toContain('nunca aceita termos automaticamente')
})
