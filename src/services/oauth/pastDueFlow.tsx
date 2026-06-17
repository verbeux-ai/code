import React, { useCallback, useEffect, useState } from 'react'

import { Select } from '../../components/CustomSelect/select.js'
import { Spinner } from '../../components/Spinner.js'
import { Box, render, Text } from '../../ink.js'
import { openBrowser } from '../../utils/browser.js'
import {
  fetchPortalUrl,
  fetchSubscriptions,
  type SubscriptionResponse,
} from '../api/verbooSubscriptions.js'

const POLL_INTERVAL_MS = 3_000
const POLL_TIMEOUT_MS = 5 * 60 * 1_000

function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100)
}

type Step = 'loading' | 'notice' | 'opening' | 'polling' | 'success' | 'error'

export function PastDueView({
  accessToken,
  onDone,
}: {
  accessToken: string
  onDone: (result: boolean) => void
}) {
  const [step, setStep] = useState<Step>('loading')
  const [pastDueGroups, setPastDueGroups] = useState<SubscriptionResponse[]>([])
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // Carrega subscriptions e filtra past_due
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const subs = await fetchSubscriptions(accessToken)
      if (cancelled) return
      const pastDue = subs.filter(s => s.status === 'past_due')
      setPastDueGroups(pastDue)
      if (pastDue.length === 0) {
        onDone(true)
      } else {
        setStep('notice')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [accessToken, onDone])

  const startPolling = useCallback(async () => {
    const startTime = Date.now()
    while (Date.now() - startTime < POLL_TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
      try {
        const subs = await fetchSubscriptions(accessToken)
        const stillPastDue = subs.some(s => s.status === 'past_due')
        if (!stillPastDue) {
          setStep('success')
          setTimeout(() => onDone(true), 1_500)
          return
        }
      } catch {
        // retry
      }
    }
    setErrorMsg('Tempo limite excedido. Seu pagamento pode nao ter sido processado.')
    setStep('error')
  }, [accessToken, onDone])

  const handlePay = useCallback(async () => {
    setStep('opening')
    try {
      const url = await fetchPortalUrl(accessToken)
      if (!url) {
        setErrorMsg('Nao foi possivel abrir o portal de pagamento.')
        setStep('error')
        return
      }
      const opened = await openBrowser(url)
      if (!opened) {
        setErrorMsg('Nao foi possivel abrir o navegador. Acesse o link manualmente: ' + url)
        setStep('error')
        return
      }
      setStep('polling')
      void startPolling()
    } catch (e) {
      setErrorMsg((e as Error).message)
      setStep('error')
    }
  }, [accessToken, startPolling])

  const handleSkip = useCallback(() => {
    onDone(false)
  }, [onDone])

  if (step === 'loading') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text>Verificando pagamentos pendentes...</Text>
        <Spinner />
      </Box>
    )
  }

  if (step === 'notice') {
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column" gap={1}>
          <Text color="yellow">⚠ Pagamento pendente</Text>
          <Text>Seu acesso aos modelos esta bloqueado ate que o pagamento seja regularizado.</Text>
          {pastDueGroups.map(sub => {
            const groupName = sub.group?.name ?? sub.groupId
            let priceDesc = ''
            if (sub.group) {
              priceDesc = ` — ${formatPrice(sub.group.priceCents, sub.group.currency)}/${sub.group.billingInterval === 'year' ? 'ano' : 'mes'}`
            }
            return (
              <Text key={sub.id}>
                • {groupName}{priceDesc}
              </Text>
            )
          })}
        </Box>
        <Select
          options={[
            { label: 'Pagar agora', value: 'pay' },
            { label: 'Ignorar', value: 'skip' },
          ]}
          onChange={(v: string) => {
            if (v === 'pay') void handlePay()
            else handleSkip()
          }}
        />
      </Box>
    )
  }

  if (step === 'opening') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text>Abrindo portal de pagamento no navegador...</Text>
        <Spinner />
      </Box>
    )
  }

  if (step === 'polling') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text>Aguardando confirmacao do pagamento...</Text>
        <Spinner />
      </Box>
    )
  }

  if (step === 'success') {
    return <Text color="green">✓ Pagamento confirmado! Acesso liberado.</Text>
  }

  // error
  return (
    <Box flexDirection="column" gap={1}>
      <Text color="red">Erro: {errorMsg}</Text>
      <Select
        options={[
          { label: 'Tentar novamente', value: 'retry' },
          { label: 'Ignorar', value: 'skip' },
        ]}
        onChange={(v: string) => {
          if (v === 'retry') void handlePay()
          else handleSkip()
        }}
      />
    </Box>
  )
}

export async function showPastDueNotice(
  accessToken: string,
): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const ref = { current: { unmount: () => {} } }

    render(
      <PastDueView
        accessToken={accessToken}
        onDone={(ok: boolean) => {
          ref.current.unmount()
          setTimeout(() => resolve(ok), 50)
        }}
      />,
    ).then(inst => {
      ref.current = inst
    })
  })
}
