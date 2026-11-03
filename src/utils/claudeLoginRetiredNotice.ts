import type { Notification } from '../context/notifications.js'
import { getGlobalConfig, saveGlobalConfig } from './config.js'

export const CLAUDE_LOGIN_RETIRED_NOTICE =
  'O login Claude por assinatura (Pro/Max) foi desativado e removido deste computador: a Anthropic não permite esse login fora dos apps dela. Para usar modelos Claude, conecte sua chave de API com /claude login.'

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
