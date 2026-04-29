import type { Command } from '../../commands.js'
import { isVerbooMode } from '../../constants/oauth.js'
import { isVerbooSessionValidated } from '../../services/oauth/verbooStartupAuth.js'
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
      // Em Verboo mode, /login só aparece quando a sessão não está validada (pós-logout)
      if (isVerbooMode()) return !isVerbooSessionValidated()
      return true
    },
    load: () => import('./login.js'),
  }) satisfies Command
