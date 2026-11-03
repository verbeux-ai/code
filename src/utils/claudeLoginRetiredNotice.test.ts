import { afterEach, expect, mock, test } from 'bun:test'

afterEach(() => {
  mock.restore()
})

async function load(suffix: string, initial: Record<string, unknown>) {
  let config = initial
  mock.module('./config.js', () => ({
    getGlobalConfig: () => config,
    saveGlobalConfig: (updater: (current: Record<string, unknown>) => Record<string, unknown>) => {
      config = updater(config)
    },
  }))
  const notice = await import(`./claudeLoginRetiredNotice.ts?${suffix}`)
  return { notice, readConfig: () => config }
}

test('shows the notice once after the subscription login was removed', async () => {
  const { notice, readConfig } = await load('pending', {
    claudeSubscriptionLoginRetiredAt: Date.now(),
    claudeSubscriptionLoginRetiredNoticeShown: false,
  })

  const first = notice.getClaudeLoginRetiredNotification()
  expect(first).toMatchObject({ key: 'claude-subscription-login-retired' })
  expect(first?.text).toContain('/claude login')
  expect(readConfig().claudeSubscriptionLoginRetiredNoticeShown).toBe(true)
  expect(notice.getClaudeLoginRetiredNotification()).toBeNull()
})

test('stays silent for users who never had the subscription login', async () => {
  const { notice } = await load('never', {})
  expect(notice.getClaudeLoginRetiredNotification()).toBeNull()
})
