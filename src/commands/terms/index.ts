import type { Command } from '../../commands.js'
import { isVerbooMode } from '../../constants/oauth.js'

const terms = {
  type: 'local-jsx',
  name: 'terms',
  description: 'View or accept the current Verboo Terms of Use',
  isEnabled: isVerbooMode,
  load: () => import('./terms.js'),
} satisfies Command

export default terms
