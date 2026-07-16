import * as React from 'react'

import { VerbooTermsAcceptance } from '../../components/VerbooTermsAcceptance.js'
import {
  fetchVerbooTermsStatus,
  formatTermsDeadline,
  getPublicTermsURL,
} from '../../services/oauth/verbooTerms.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { getClaudeAIOAuthTokensAsync } from '../../utils/auth.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
): Promise<React.ReactNode | null> {
  const tokens = await getClaudeAIOAuthTokensAsync()
  if (!tokens?.accessToken) {
    onDone('Você precisa entrar na sua conta antes de consultar os termos.', {
      display: 'system',
    })
    return null
  }

  const result = await fetchVerbooTermsStatus(tokens.accessToken)
  if (result.kind === 'unauthorized') {
    onDone('Sua sessão expirou. Execute /login e tente novamente.', {
      display: 'system',
    })
    return null
  }
  if (result.kind === 'unavailable') {
    onDone(`Não foi possível verificar os termos: ${result.reason}.`, {
      display: 'system',
    })
    return null
  }

  const { status } = result
  if (!status.configured || !status.current) {
    onDone('Ainda não há Termos de Uso publicados.', { display: 'system' })
    return null
  }

  if (!status.mustAccept && !status.pendingReacceptance) {
    onDone(
      `Termos de Uso versão ${status.current.version} aceitos${
        status.acceptedAt ? ` em ${new Date(status.acceptedAt).toLocaleString('pt-BR')}` : ''
      }.\n${getPublicTermsURL(status)}`,
      { display: 'system' },
    )
    return null
  }

  return (
    <VerbooTermsAcceptance
      accessToken={tokens.accessToken}
      initialStatus={status}
      onDone={acceptance => {
        if (acceptance.kind === 'accepted') {
          onDone(
            `Termos de Uso versão ${status.current?.version} aceitos e registrados pelo servidor.`,
            { display: 'system' },
          )
          return
        }
        const deadline = formatTermsDeadline(status.current?.enforcementAt)
        onDone(
          status.mustAccept
            ? 'Termos não aceitos. O acesso ao produto permanece bloqueado.'
            : `Termos não aceitos agora.${deadline ? ` O bloqueio começa em ${deadline}.` : ''}`,
          { display: 'system' },
        )
      }}
    />
  )
}
