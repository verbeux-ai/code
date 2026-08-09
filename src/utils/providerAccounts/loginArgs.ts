export type ProviderLoginArgs =
  | { action: 'login'; reconnectLocalAccountId?: string }
  | { action: 'status' }
  | { action: 'logout' }
  | { action: 'invalid' }

export function parseProviderLoginArgs(raw: string): ProviderLoginArgs {
  const parts = raw.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0 || parts[0] === 'login') {
    if (
      parts[1] === '--reconnect' &&
      parts[2] &&
      !parts[2].startsWith('--') &&
      parts.length === 3
    ) {
      return { action: 'login', reconnectLocalAccountId: parts[2] }
    }
    return parts.length <= 1 ? { action: 'login' } : { action: 'invalid' }
  }
  if (parts.length === 1 && parts[0] === 'status') return { action: 'status' }
  if (parts.length === 1 && parts[0] === 'logout') return { action: 'logout' }
  return { action: 'invalid' }
}
