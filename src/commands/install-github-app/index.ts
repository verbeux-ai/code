import type { Command } from '../../commands.js'
import { isVerbooMode } from '../../constants/oauth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

const installGitHubApp = {
  type: 'local-jsx',
  name: 'install-github-app',
  description: 'Set up Claude GitHub Actions for a repository',
  availability: ['claude-ai', 'console'],
  // VERBOO-BRAND: the flow installs Anthropic's GitHub App and the
  // anthropics/claude-code-action workflow with an ANTHROPIC_API_KEY secret,
  // none of which work with a Verboo account. Hidden until Verboo ships its own.
  isEnabled: () =>
    !isVerbooMode() &&
    !isEnvTruthy(process.env.DISABLE_INSTALL_GITHUB_APP_COMMAND),
  load: () => import('./install-github-app.js'),
} satisfies Command

export default installGitHubApp
