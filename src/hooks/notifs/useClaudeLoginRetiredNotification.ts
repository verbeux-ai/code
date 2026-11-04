import { getClaudeLoginRetiredNotification } from '../../utils/claudeLoginRetiredNotice.js'
import { useStartupNotification } from './useStartupNotification.js'

export function useClaudeLoginRetiredNotification(): void {
  useStartupNotification(getClaudeLoginRetiredNotification)
}
