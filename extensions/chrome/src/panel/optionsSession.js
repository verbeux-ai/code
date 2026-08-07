/**
 * Resolve the session shown by the options page.
 * The service worker is authoritative because it can refresh an expired OAuth
 * token before returning the session. Local storage is only a race/offline
 * fallback.
 */

/**
 * @param {{ requestAuthState: () => Promise<{ ok?: boolean; session?: unknown }>; loadStoredSession: () => Promise<unknown> }} deps
 * @returns {Promise<unknown>}
 */
export async function loadOptionsSession({ requestAuthState, loadStoredSession }) {
  const response = await requestAuthState()
  if (response?.ok) return response.session ?? null
  return loadStoredSession()
}
