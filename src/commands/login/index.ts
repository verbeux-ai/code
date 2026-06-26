import type { Command } from '../../commands.js'
import { hasAnthropicApiKeyAuth } from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

export default () =>
  ({
    type: 'local-jsx',
    name: 'login',
    // VERBOO-BRAND
    description: hasAnthropicApiKeyAuth()
      ? 'Switch Verboo accounts'
      : 'Sign in with your Verboo account',
    isEnabled: () => {
      if (isEnvTruthy(process.env.DISABLE_LOGIN_COMMAND)) return false
      return true
    },
    load: () => import('./login.js'),
  }) satisfies Command
