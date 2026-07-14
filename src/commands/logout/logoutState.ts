import type { SecureStorage } from '../../utils/secureStorage/index.js'

/** Removes only the native Verboo OAuth record, preserving unrelated secrets. */
export function removeStoredVerbooOauth(
  secureStorage: SecureStorage,
): string | null {
  const storageData = secureStorage.read() ?? {}
  const refreshToken = storageData.verbooOauth?.refreshToken ?? null

  if (!storageData.verbooOauth) {
    return refreshToken
  }

  delete storageData.verbooOauth
  const isEmpty = Object.keys(storageData).length === 0
  const success = isEmpty
    ? secureStorage.delete()
    : secureStorage.update(storageData).success
  if (!success) {
    throw new Error('Failed to clear local Verboo credentials')
  }
  return refreshToken
}
