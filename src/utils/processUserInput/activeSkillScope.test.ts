import { describe, expect, test } from 'bun:test'
import { getActiveSkillScopeForQueuedContinuation } from './activeSkillScope.js'

const scope = (overrides: Record<string, unknown> = {}) => ({
  type: 'attachment',
  attachment: {
    type: 'command_permissions',
    allowedTools: ['Read', 'Agent'],
    model: 'gpt-5.6-sol',
    effort: 'high',
    ...overrides,
  },
})

describe('getActiveSkillScopeForQueuedContinuation', () => {
  test('restores the latest skill scope for a task notification', () => {
    expect(
      getActiveSkillScopeForQueuedContinuation(
        [
          { type: 'user', isMeta: false },
          scope(),
          { type: 'assistant' },
          {
            type: 'user',
            origin: { kind: 'task-notification' },
          },
        ] as never,
        'task-notification',
      ),
    ).toEqual({
      allowedTools: ['Read', 'Agent'],
      model: 'gpt-5.6-sol',
      effort: 'high',
    })
  })

  test('uses the newest nested skill scope', () => {
    expect(
      getActiveSkillScopeForQueuedContinuation(
        [
          scope(),
          scope({
            allowedTools: ['Read', 'Bash'],
            model: 'max/deepseek-v4-pro',
            effort: 'medium',
          }),
        ] as never,
        'task-notification',
      ),
    ).toEqual({
      allowedTools: ['Read', 'Bash'],
      model: 'max/deepseek-v4-pro',
      effort: 'medium',
    })
  })

  test('does not apply a skill scope to an ordinary user turn', () => {
    expect(
      getActiveSkillScopeForQueuedContinuation(
        [scope()] as never,
        'prompt',
      ),
    ).toBeNull()
  })

  test('does not revive a skill after a later visible user prompt', () => {
    expect(
      getActiveSkillScopeForQueuedContinuation(
        [scope(), { type: 'user', isMeta: false }] as never,
        'task-notification',
      ),
    ).toBeNull()
  })
})
