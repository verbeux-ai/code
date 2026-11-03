import type { Command } from '../../commands.js'

// Opened by the REPL when the user's own account (ChatGPT plan, OpenAI or
// Anthropic key) runs out; offers to continue on a Verboo model.
export default {
  type: 'local-jsx',
  name: 'limit-switch',
  description: 'Trocar para um modelo Verboo quando o limite da sua conta acaba',
  isHidden: true,
  load: () => import('./limit-switch.js'),
} satisfies Command
