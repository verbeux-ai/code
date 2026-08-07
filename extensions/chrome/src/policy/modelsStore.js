/**
 * modelsStore.js — Selected model persistence.
 *
 * The available model catalog is fetched live by background.js (from
 * https://code.verboo.ai/router/v1/models with the user's Bearer token)
 * and broadcast via MSG.MODELS_STATE_CHANGED. The renderer only
 * persists the SELECTION here — never the catalog itself.
 *
 * Stored in chrome.storage.local under key 'verbooSelectedModel'.
 *
 * Multi-user: selection is per-extension-instance.
 */

const STORAGE_KEY = 'verbooSelectedModel'

/**
 * @typedef {Object} ModelDescriptor
 * @property {string} id                 - Model identifier (e.g. "openai/gpt-5")
 * @property {string} [label]            - Human label (preferred over id when present)
 * @property {string} [provider]         - Provider name (e.g. "openai", "anthropic")
 * @property {boolean} [supportsVision]  - Can accept image inputs
 * @property {string} [reasoning]        - Reasoning tier label (e.g. "high")
 */

/**
 * @param {ModelDescriptor[]} models
 * @returns {string | undefined} - modelId of the preferred vision model
 */
export function pickPreferredModelId(models) {
  if (!Array.isArray(models) || models.length === 0) return undefined
  // Backend sorts vision first per ANVIL; defend if it doesn't.
  const vision = models.find((m) => m?.supportsVision && m?.id)
  return vision?.id ?? models.find((m) => m?.id)?.id
}

/**
 * @returns {Promise<string | undefined>}
 */
export async function loadSelectedModelId() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY)
    return result[STORAGE_KEY] ?? undefined
  } catch {
    return undefined
  }
}

/**
 * @param {string | undefined} modelId
 */
export async function saveSelectedModelId(modelId) {
  if (modelId) {
    await chrome.storage.local.set({ [STORAGE_KEY]: modelId })
  } else {
    await chrome.storage.local.remove(STORAGE_KEY)
  }
}

/**
 * Reconcile a persisted selection against the current model catalog.
 * If the saved modelId is no longer in the catalog (provider dropped
 * the model), fall back to the preferred vision model.
 *
 * @param {ModelDescriptor[]} models
 * @param {string | undefined} savedId
 * @returns {string | undefined} - the id that SHOULD be selected
 */
export function reconcileSelection(models, savedId) {
  if (savedId && models.some((m) => m.id === savedId)) return savedId
  return pickPreferredModelId(models)
}