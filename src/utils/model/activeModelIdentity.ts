import { getCachedClaudeNativeModels } from '../../services/api/claudeNativeModels.js'
import { getCachedCodexModels } from '../../services/api/codexModels.js'
import { getCachedVerbooModels } from '../../services/api/verbooModels.js'

export type ActiveModelProvider = 'Verboo' | 'Codex' | 'Claude'

type ModelReference = { id: string }

export type ActiveModelCatalogs = {
  verboo: readonly ModelReference[] | null
  codex: readonly ModelReference[] | null
  claude: readonly ModelReference[] | null
}

function comparableModelId(modelId: string): string {
  return modelId.trim().replace(/\[1m\]$/i, '').trim()
}

function catalogContains(
  catalog: readonly ModelReference[] | null,
  modelId: string,
): boolean {
  return catalog?.some(model => model.id === modelId) === true
}

export function classifyActiveModelProvider(
  modelId: string,
  catalogs: ActiveModelCatalogs,
): ActiveModelProvider {
  const comparable = comparableModelId(modelId)

  // Match the routing order in services/api/client.ts. An ID exposed by the
  // Verboo catalog always routes through Verboo even if another catalog also
  // happens to expose the same ID.
  if (catalogContains(catalogs.verboo, comparable)) return 'Verboo'
  if (catalogContains(catalogs.codex, comparable)) return 'Codex'
  if (catalogContains(catalogs.claude, comparable)) return 'Claude'

  // Catalogs are normally primed before the interactive UI appears. These
  // fallbacks keep early/degraded startup labels useful without changing the
  // routing decision itself.
  if (/(?:^|[-_/])(claude|sonnet|opus|haiku)(?:$|[-_/])/i.test(comparable)) {
    return 'Claude'
  }
  if (/^(?:gpt-|o\d)|(?:^|[-_/])codex(?:$|[-_/])/i.test(comparable)) {
    return 'Codex'
  }
  return 'Verboo'
}

export function getActiveModelIdentity(modelId: string): {
  provider: ActiveModelProvider
  model: string
} {
  const model = modelId.trim()
  return {
    provider: classifyActiveModelProvider(model, {
      verboo: getCachedVerbooModels(),
      codex: getCachedCodexModels(),
      claude: getCachedClaudeNativeModels(),
    }),
    model,
  }
}
