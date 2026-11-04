const KEY_COMMAND = /^\s*\/(claude|openai)(\s|$)/
const PROVIDER_KEY = /\bsk-[A-Za-z0-9_-]{8,}/g

/**
 * /claude and /openai only take a key through their masked prompt. One typed as
 * an argument by mistake must not stay on screen, in history or in a transcript.
 */
export function redactProviderKeyInCommand(input: string): string {
  return KEY_COMMAND.test(input) ? input.replace(PROVIDER_KEY, '***') : input
}
