import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'claude',
  description: 'Conectar sua chave de API da Anthropic para usar modelos Claude no Verboo Code',
  argumentHint: '[login|status|logout]',
  load: () => import('./claude.js'),
} satisfies Command
