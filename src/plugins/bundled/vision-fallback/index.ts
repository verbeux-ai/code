import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { registerBuiltinPlugin } from '../../builtinPlugins.js'

const VISION_FALLBACK_SYSTEM_PROMPT = `You are a vision assistant running inside a UserPromptSubmit hook.

When the hook input contains \`attachments\` with images, describe each image accurately and concisely. Then return ONLY a JSON object in this exact format:

{\n  "hookSpecificOutput": {\n    "additionalContext": "[img1] <description>\\n[img2] <description>"\n  }\n}\n
If there are no attachments, return:

{\n  "hookSpecificOutput": {}\n}\n
If you cannot describe the images, return:

{\n  "hookSpecificOutput": {\n    "additionalContext": "Aviso: não foi possível descrever a imagem anexada."\n  }\n}\n
Do not include markdown code fences, explanations, or any text outside the JSON object.`

const runtimePath = join(
  dirname(fileURLToPath(import.meta.url)),
  'runtime.js',
)

export function registerVisionFallbackPlugin(): void {
  registerBuiltinPlugin({
    name: 'vision-fallback',
    description:
      'Gives text-only models the ability to process images by describing them with a vision model before the main model responds.',
    version: '0.1.0',
    defaultEnabled: true,
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: `node "${runtimePath}"`,
              timeout: 60,
              statusMessage: 'Analyzing image with vision fallback...',
            },
          ],
        },
      ],
    },
  })
}

export { VISION_FALLBACK_SYSTEM_PROMPT }
