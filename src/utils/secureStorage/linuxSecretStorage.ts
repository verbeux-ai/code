import { execaSync } from 'execa'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import {
  CREDENTIALS_SERVICE_SUFFIX,
  getSecureStorageServiceName,
  getUsername,
} from './macOsKeychainHelpers.js'
import type { SecureStorage, SecureStorageData, SecureStorageReadResult } from './index.js'

/**
 * Linux-specific secure storage implementation using the secret-tool CLI.
 * secret-tool interacts with the Secret Service API (GNOME Keyring, KWallet, etc.).
 */
export const linuxSecretStorage: SecureStorage = {
  name: 'libsecret',
  read(): SecureStorageData | null {
    try {
      const username = getUsername()
      const serviceName = getSecureStorageServiceName(
        CREDENTIALS_SERVICE_SUFFIX,
      )
      // secret-tool lookup service [service] account [account]
      const result = execaSync(
        'secret-tool',
        ['lookup', 'service', serviceName, 'account', username],
        { reject: false },
      )

      if (result.exitCode === 0 && result.stdout) {
        return jsonParse(result.stdout)
      }
    } catch {
      // fall through
    }
    return null
  },
  readResult(): SecureStorageReadResult {
    try {
      const username = getUsername()
      const serviceName = getSecureStorageServiceName(
        CREDENTIALS_SERVICE_SUFFIX,
      )
      const result = execaSync(
        'secret-tool',
        ['lookup', 'service', serviceName, 'account', username],
        { reject: false },
      )
      if (result.exitCode === 0 && result.stdout) {
        try {
          return { kind: 'ok', data: jsonParse(result.stdout) }
        } catch {
          return { kind: 'error', warning: 'Secret Service returned malformed JSON.' }
        }
      }
      // secret-tool uses exit code 1 for a missing item. A thrown spawn (for
      // example, secret-tool is not installed) is handled as an error below.
      if (result.exitCode === 1) return { kind: 'missing' }
      return { kind: 'error', warning: result.stderr?.trim() || 'Secret Service read failed.' }
    } catch {
      return { kind: 'error', warning: 'Secret Service read failed.' }
    }
  },
  async readAsync(): Promise<SecureStorageData | null> {
    // Reusing sync implementation for simplicity as it wraps a CLI call
    return this.read()
  },
  update(data: SecureStorageData): { success: boolean; warning?: string } {
    try {
      const username = getUsername()
      const serviceName = getSecureStorageServiceName(
        CREDENTIALS_SERVICE_SUFFIX,
      )
      const payload = jsonStringify(data)
      // secret-tool store --label=[label] service [service] account [account]
      // The payload is passed via stdin
      const result = execaSync(
        'secret-tool',
        [
          'store',
          '--label',
          serviceName,
          'service',
          serviceName,
          'account',
          username,
        ],
        { input: payload, reject: false },
      )

      return { success: result.exitCode === 0 }
    } catch {
      return { success: false }
    }
  },
  delete(): boolean {
    try {
      const username = getUsername()
      const serviceName = getSecureStorageServiceName(
        CREDENTIALS_SERVICE_SUFFIX,
      )
      // secret-tool clear service [service] account [account]
      const result = execaSync(
        'secret-tool',
        ['clear', 'service', serviceName, 'account', username],
        { reject: false },
      )
      return result.exitCode === 0
    } catch {
      return false
    }
  },
}
