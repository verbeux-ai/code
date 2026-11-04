import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'openai',
  description: 'Conectar sua chave de API da OpenAI para usar modelos GPT no Verboo Code',
  argumentHint: '[login|status|logout]',
  load: () => import('./openai.js'),
} satisfies Command
