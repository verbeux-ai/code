import { afterEach, expect, test } from 'bun:test'
import type { UUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getSessionId,
  getSessionProjectDir,
  switchSession,
} from '../bootstrap/state.js'
import {
  adoptResumedSessionFile,
  enrichLogs,
  flushSessionStorage,
  getSessionFilesLite,
  recordAiGeneratedTitle,
  saveCustomTitle,
} from './sessionStorage.js'

const session = getSessionId()
const originalProjectDir = getSessionProjectDir()
const originalPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
const tempDirs: string[] = []

afterEach(async () => {
  switchSession(session, originalProjectDir)
  if (originalPersistence === undefined) {
    delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  } else {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalPersistence
  }
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function sessionWithFirstPrompt(prompt: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'resume-title-'))
  tempDirs.push(dir)
  switchSession(session, dir)
  const file = join(dir, `${session}.jsonl`)
  await writeFile(
    file,
    JSON.stringify({
      type: 'user',
      uuid: '00000000-0000-4000-8000-000000000001',
      parentUuid: null,
      timestamp: '2026-10-30T00:00:00.000Z',
      cwd: dir,
      userType: 'external',
      sessionId: session,
      version: 'test',
      isSidechain: false,
      isMeta: false,
      message: { role: 'user', content: prompt },
    }) + '\n',
  )
  adoptResumedSessionFile()
  return dir
}

async function resumeListTitle(dir: string): Promise<string | undefined> {
  const { logs } = await enrichLogs(await getSessionFilesLite(dir), 0, 10)
  return logs.find(log => log.sessionId === session)?.customTitle
}

test('the generated title is what /resume lists, and a user title still wins', async () => {
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  const dir = await sessionWithFirstPrompt('please fix the login button on mobile')

  await recordAiGeneratedTitle('Fix login button on mobile')
  await flushSessionStorage()
  expect(await resumeListTitle(dir)).toBe('Fix login button on mobile')

  await saveCustomTitle(session as UUID, 'my-session')
  await recordAiGeneratedTitle('A later AI title')
  await flushSessionStorage()
  expect(await resumeListTitle(dir)).toBe('my-session')
})

test('nothing is written when session persistence is off', async () => {
  delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  const dir = await sessionWithFirstPrompt('add dark mode')

  await recordAiGeneratedTitle('Add dark mode')
  await flushSessionStorage()

  const contents = await readFile(join(dir, `${session}.jsonl`), 'utf8')
  expect(contents).not.toContain('"type":"ai-title"')
})
