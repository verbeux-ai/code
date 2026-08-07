/**
 * Chrome Permission Mode persistence.
 *
 * Modes (product UI): 'manual' | 'skip'.
 * Legacy 'auto' is still accepted on read and migrated → 'skip'
 * (auto was the permissive path; skip is the same for non-elevated tools).
 *
 * Stored in chrome.storage.local under key 'chromePermissionMode'.
 * Multi-user: mode is per-extension-instance.
 */

const STORAGE_KEY = 'chromePermissionMode'

/** @typedef {'manual' | 'skip'} ChromePermissionMode */
/** @typedef {'manual' | 'auto' | 'skip'} StoredChromePermissionMode */

/**
 * @returns {Promise<ChromePermissionMode>}
 */
export async function loadMode() {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  const mode = result[STORAGE_KEY]
  // Legacy: auto was "run without asking" for normal tools — same as skip.
  if (mode === 'auto') {
    await chrome.storage.local.set({ [STORAGE_KEY]: 'skip' })
    return 'skip'
  }
  if (mode === 'manual' || mode === 'skip') return mode
  return 'manual' // default
}

/**
 * @param {ChromePermissionMode | 'auto'} mode
 */
export async function saveMode(mode) {
  const next = mode === 'auto' ? 'skip' : mode
  if (next !== 'manual' && next !== 'skip') {
    throw new Error(`saveMode: invalid mode ${mode}`)
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: next })
}
