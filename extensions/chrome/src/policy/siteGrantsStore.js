/**
 * Site Grant persistence — per-host allow/deny decisions.
 *
 * Stored in chrome.storage.local under key 'siteGrants'.
 * Each grant: { host: string, decision: 'once' | 'always' | 'deny', updatedAt: number }
 *
 * Multi-user: grants are per-extension-instance; no user identity stored.
 */

const STORAGE_KEY = 'siteGrants'

/** @typedef {'once' | 'always' | 'deny'} GrantDecision */

/** @typedef {{ host: string; decision: GrantDecision; updatedAt: number }} SiteGrant */

/**
 * @returns {Promise<SiteGrant[]>}
 */
export async function loadGrants() {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  return /** @type {SiteGrant[]} */ (result[STORAGE_KEY] ?? [])
}

/**
 * @param {SiteGrant[]} grants
 */
export async function saveGrants(grants) {
  await chrome.storage.local.set({ [STORAGE_KEY]: grants })
}

/**
 * Add or update a grant for a host.
 * @param {string} host
 * @param {GrantDecision} decision
 */
export async function upsertGrant(host, decision) {
  const grants = await loadGrants()
  const existing = grants.findIndex((g) => g.host === host)
  const grant = { host, decision, updatedAt: Date.now() }
  if (existing !== -1) {
    grants[existing] = grant
  } else {
    grants.push(grant)
  }
  await saveGrants(grants)
  return grant
}

/**
 * Remove grant for a host.
 * @param {string} host
 */
export async function removeGrant(host) {
  const grants = await loadGrants()
  await saveGrants(grants.filter((g) => g.host !== host))
}

/**
 * Get decision for a host, or undefined.
 * @param {string} host
 * @returns {Promise<GrantDecision | undefined>}
 */
export async function getGrant(host) {
  const grants = await loadGrants()
  return grants.find((g) => g.host === host)?.decision
}
