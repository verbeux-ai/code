import { describe, expect, it } from 'bun:test'
import { formatProviderAccountStatus } from './status.js'

describe('provider account status', () => {
  it('shows the account count and sanitized default label', () => {
    const message = formatProviderAccountStatus('codex', [
      {
        provider: 'codex',
        accountId: 'local-a',
        displayLabel: 'Codex 1',
        isDefault: false,
        connectionState: 'connected',
      },
      {
        provider: 'codex',
        accountId: 'local-b',
        displayLabel: 'Codex 2',
        isDefault: true,
        connectionState: 'connected',
      },
    ])

    expect(message).toContain('2 contas')
    expect(message).toContain('Codex 2')
    expect(message).not.toContain('local-b')
  })

  it('does not expose provider subjects or emails in the disconnected state', () => {
    expect(formatProviderAccountStatus('claude', [])).toBe(
      'Claude não conectado. Execute /claude login para desbloquear modelos adicionais.',
    )
  })
})
