import * as React from 'react'

import { Select } from './CustomSelect/select.js'
import { Dialog } from './design-system/Dialog.js'
import { Spinner } from './Spinner.js'
import { Box, render, Text } from '../ink.js'
import {
  acceptVerbooTerms,
  fetchVerbooTermsStatus,
  formatTermsDeadline,
  getPublicTermsURL,
  type VerbooTermsStatus,
} from '../services/oauth/verbooTerms.js'
import { errorMessage } from '../utils/errors.js'

export type VerbooTermsAcceptanceResult =
  | { kind: 'accepted'; acceptedAt: string }
  | { kind: 'cancelled' }

export function VerbooTermsAcceptance({
  accessToken,
  initialStatus,
  onDone,
}: {
  accessToken: string
  initialStatus: VerbooTermsStatus
  onDone: (result: VerbooTermsAcceptanceResult) => void
}): React.ReactNode {
  const [status, setStatus] = React.useState(initialStatus)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const current = status.current
  const publicURL = getPublicTermsURL(status)
  const deadline = formatTermsDeadline(current?.enforcementAt)

  const accept = React.useCallback(async () => {
    if (!current || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const acceptance = await acceptVerbooTerms(
        accessToken,
        current.id,
        current.locale,
      )
      onDone({ kind: 'accepted', acceptedAt: acceptance.acceptedAt })
    } catch (acceptError) {
      const refreshed = await fetchVerbooTermsStatus(accessToken, current.locale)
      if (refreshed.kind === 'ok') setStatus(refreshed.status)
      setError(
        `${errorMessage(acceptError)} Confira a versão exibida e tente novamente.`,
      )
      setSubmitting(false)
    }
  }, [accessToken, current, onDone, submitting])

  return (
    <Dialog
      title="Termos de Uso do Verboo Code"
      subtitle={current ? `Versão ${current.version} · ${current.title}` : undefined}
      onCancel={() => onDone({ kind: 'cancelled' })}
      color="permission"
      hideInputGuide={submitting}
      isCancelActive={!submitting}
    >
      <Box flexDirection="column" gap={1}>
        {current?.changeSummary ? <Text>{current.changeSummary}</Text> : null}
        <Text>
          Leia a íntegra antes de decidir:{' '}
          <Text color="ide">{publicURL}</Text>
        </Text>
        {deadline ? (
          <Text color={status.mustAccept ? 'error' : 'warning'}>
            {status.mustAccept
              ? `O acesso está bloqueado desde ${deadline} (horário de Fortaleza).`
              : `O aceite será obrigatório em ${deadline} (horário de Fortaleza).`}
          </Text>
        ) : null}
        <Text dimColor>
          O servidor registra data e hora, versão/hash, IP, agente do usuário,
          idioma, canal CLI, cliente OAuth e ID da requisição como evidência.
        </Text>
        {error ? <Text color="error">{error}</Text> : null}
        {submitting ? (
          <Box gap={1}>
            <Spinner />
            <Text>Registrando o aceite…</Text>
          </Box>
        ) : current ? (
          <Select
            options={[
              {
                label: `Li e aceito os Termos de Uso da versão ${current.version}`,
                value: 'accept' as const,
              },
              {
                label: 'Não aceito agora',
                value: 'cancel' as const,
              },
            ]}
            onChange={value => {
              if (value === 'accept') void accept()
              else onDone({ kind: 'cancelled' })
            }}
            onCancel={() => onDone({ kind: 'cancelled' })}
          />
        ) : (
          <Text color="error">Não foi possível identificar a versão vigente.</Text>
        )}
      </Box>
    </Dialog>
  )
}

export async function showVerbooTermsAcceptance(
  accessToken: string,
  status: VerbooTermsStatus,
): Promise<VerbooTermsAcceptanceResult> {
  return new Promise((resolve, reject) => {
    let instance: { unmount: () => void } | null = null
    let pendingResult: VerbooTermsAcceptanceResult | null = null
    let settled = false

    const finish = (result: VerbooTermsAcceptanceResult) => {
      if (settled) return
      pendingResult = result
      if (!instance) return
      settled = true
      instance.unmount()
      setTimeout(() => resolve(result), 50)
    }

    render(
      <VerbooTermsAcceptance
        accessToken={accessToken}
        initialStatus={status}
        onDone={finish}
      />,
    ).then(created => {
      instance = created
      if (pendingResult) finish(pendingResult)
    }).catch(reject)
  })
}
