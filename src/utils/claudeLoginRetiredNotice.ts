import type { Notification } from '../context/notifications.js'
import { getGlobalConfig, saveGlobalConfig } from './config.js'

export const CLAUDE_LOGIN_RETIRED_NOTICE =
  'Login Claude desativado. Use /claude login.'

/**
 * One-time notice after startup removed a stored Claude subscription login
 * (see retireClaudeSubscriptionLogins in verbooStartupAuth.ts).
 */
export function getClaudeLoginRetiredNotification(): Notification | null {
  const config = getGlobalConfig()
  if (
    !config.claudeSubscriptionLoginRetiredAt ||
    config.claudeSubscriptionLoginRetiredNoticeShown
  ) {
    return null
  }
  saveGlobalConfig(current => ({
    ...current,
    claudeSubscriptionLoginRetiredNoticeShown: true,
  }))
  return {
    key: 'claude-subscription-login-retired',
    text: CLAUDE_LOGIN_RETIRED_NOTICE,
    color: 'warning',
    priority: 'high',
    timeoutMs: 15000,
  }
}
