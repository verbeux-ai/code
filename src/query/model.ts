import type { PermissionMode } from '../utils/permissions/PermissionMode.js'
import {
  parseAgentModelProfileReference,
  resolveAgentProfileModel,
} from '../services/api/agentRouting.js'
import { getCachedVerbooModels } from '../services/api/verbooModels.js'
import {
  getDefaultMainLoopModelSetting,
  getRuntimeMainLoopModel,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'

export type ResolveQueryTurnModelParams = {
  permissionMode: PermissionMode
  turnModel?: string
  sessionModel?: string | null
  exceeds200kTokens?: boolean
}

/**
 * Resolve the model for one query turn.
 *
 * A slash command or skill can override the model for only that turn through
 * ToolUseContext. The persisted session model is a fallback, not an override;
 * otherwise SKILL.md `model:` is silently replaced immediately before the API
 * call.
 */
export function resolveQueryTurnModel({
  permissionMode,
  turnModel,
  sessionModel,
  exceeds200kTokens = false,
}: ResolveQueryTurnModelParams): string {
  const turnProfile = parseAgentModelProfileReference(turnModel)
  const profileModel = turnProfile
    ? resolveAgentProfileModel(
        turnProfile,
        getCachedVerbooModels() ?? [],
      )
    : null
  const requestedModel =
    (turnProfile ? profileModel : turnModel) ??
    parseUserSpecifiedModel(
      sessionModel ?? getDefaultMainLoopModelSetting(),
    )

  return getRuntimeMainLoopModel({
    permissionMode,
    mainLoopModel: requestedModel,
    exceeds200kTokens,
  })
}
