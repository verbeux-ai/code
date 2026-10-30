import { isVerbooMode } from '../../constants/oauth.js'
import type { AssistantMessage } from '../../types/message.js'
import { getSmallFastModel } from '../../utils/model/model.js'
import { queryHaiku, queryWithModel } from './claude.js'
import { getCachedClaudeNativeModels } from './claudeNativeModels.js'
import { getCachedCodexModels } from './codexModels.js'
import { getCachedVerbooModels, getVerbooAgentModelForRole } from './verbooModels.js'

/**
 * The model the router assigns to the "fast" agent role (`agent_model_roles`
 * on `/models`), or undefined when not in Verboo mode or not advertised.
 */
export function getVerbooFastRoleModel(): string | undefined {
  if (!isVerbooMode()) return undefined
  return getVerbooAgentModelForRole('fast')
}

/** The model queryFastModel() sends side queries to. */
export function getSideQueryModel(): string {
  return getVerbooFastRoleModel() ?? getSmallFastModel()
}

/**
 * Whether a side query may request structured output (`output_format`).
 * Outside Verboo mode nothing changes. In Verboo mode the router rejects it
 * for most plans (403 structured_output_not_enabled), while the Codex and
 * Claude-native transports the CLI talks to directly do support it. An
 * unknown model is treated as a router model (plain text is always safe).
 */
export function sideQuerySupportsStructuredOutput(
  model: string = getSideQueryModel(),
): boolean {
  if (!isVerbooMode()) return true
  const id = model.replace(/\[1m\]$/i, '').trim()
  // Same precedence as the Verboo client: router catalog first.
  if (getCachedVerbooModels()?.some(candidate => candidate.id === id)) {
    return false
  }
  return Boolean(
    getCachedCodexModels()?.some(candidate => candidate.id === id) ||
      getCachedClaudeNativeModels()?.some(candidate => candidate.id === id),
  )
}

/**
 * Small side queries (session titles, WebFetch summaries). In Verboo mode they
 * run on the catalog's "fast" role model when the router advertises one;
 * otherwise they keep queryHaiku's small-fast model (which is the main model
 * in Verboo mode), so a router without roles behaves exactly as before.
 */
export function queryFastModel(
  args: Parameters<typeof queryHaiku>[0],
): Promise<AssistantMessage> {
  const fastModel = getVerbooFastRoleModel()
  if (!fastModel) return queryHaiku(args)
  return queryWithModel({
    ...args,
    options: { ...args.options, model: fastModel },
  })
}
