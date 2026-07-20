import React, { useCallback, useEffect, useState } from 'react'

import { Select } from '../../components/CustomSelect/select.js'
import { Spinner } from '../../components/Spinner.js'
import { Box, render, Text } from '../../ink.js'
import { openBrowser } from '../../utils/browser.js'
import { VerbooApiError } from '../api/verbooApiError.js'
import {
  fetchPortalUrl,
  fetchSubscriptions,
  type SubscriptionResponse,
} from '../api/verbooSubscriptions.js'
import { describePurchaseError } from './purchaseErrors.js'
import {
  formatPastDuePlanNames,
  getPastDueAccessDecision,
} from './subscriptionAccess.js'

const POLL_INTERVAL_MS = 3_000
const POLL_TIMEOUT_MS = 5 * 60 * 1_000

function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100)
}

function getPastDueWarningMessage(
  subscriptions: SubscriptionResponse[],
): string {
  return [
    `⚠ Pagamento pendente em ${formatPastDuePlanNames(subscriptions)}.`,
    'Seu acesso pelos outros planos ativos continua liberado; regularize no painel de assinaturas.',
  ].join(' ')
}

type Step =
  | 'loading'
  | 'notice'
  | 'warning'
  | 'opening'
  | 'polling'
  | 'success'
  | 'error'
type ErrorSource = 'loading' | 'portal' | 'polling'

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
  const [errorSource, setErrorSource] = useState<ErrorSource>('loading')
  const requestRef = React.useRef<AbortController | null>(null)
  const completionTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )

  const loadSubscriptions = useCallback(async () => {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setStep('loading')
    setErrorMsg(null)
    try {
      const subscriptions = await fetchSubscriptions(accessToken, {
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      const decision = getPastDueAccessDecision(subscriptions)
      setPastDueGroups(decision.pastDueSubscriptions)
      if (decision.kind === 'continue') onDone(true)
      else setStep(decision.kind === 'warn' ? 'warning' : 'notice')
    } catch (error) {
      if (controller.signal.aborted) return
      setErrorSource('loading')
      setErrorMsg(
        describePurchaseError(
          error,
          'Não foi possível validar seus pagamentos.',
        ).message,
      )
      setStep('error')
    }
  }, [accessToken, onDone])

  useEffect(() => {
    if (step !== 'warning') return
    const timer = setTimeout(() => onDone(true), 0)
    return () => clearTimeout(timer)
  }, [onDone, step])

  useEffect(() => {
    void loadSubscriptions()
    return () => {
      requestRef.current?.abort()
      if (completionTimerRef.current) clearTimeout(completionTimerRef.current)
    }
  }, [loadSubscriptions])

  const startPolling = useCallback(async () => {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setStep('polling')
    const startTime = Date.now()
    while (
      !controller.signal.aborted &&
      Date.now() - startTime < POLL_TIMEOUT_MS
    ) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
      if (controller.signal.aborted) return
      try {
        const subscriptions = await fetchSubscriptions(accessToken, {
          signal: controller.signal,
        })
        if (getPastDueAccessDecision(subscriptions).kind !== 'block') {
          setStep('success')
          completionTimerRef.current = setTimeout(() => onDone(true), 1_500)
          return
        }
      } catch (error) {
        if (controller.signal.aborted) return
        if (
          error instanceof VerbooApiError &&
          (error.status === 401 ||
            error.status === 403 ||
            error.kind === 'contract')
        ) {
          setErrorSource('polling')
          setErrorMsg(
            describePurchaseError(
              error,
              'Não foi possível validar o pagamento.',
            ).message,
          )
          setStep('error')
          return
        }
        // Webhooks and the local subscription view are eventually consistent.
      }
    }
    if (!controller.signal.aborted) {
      setErrorSource('polling')
      setErrorMsg(
        'O pagamento ainda não foi confirmado. Você pode verificar novamente.',
      )
      setStep('error')
    }
  }, [accessToken, onDone])

  const handlePay = useCallback(async () => {
    setStep('opening')
    setErrorMsg(null)
    try {
      const url = await fetchPortalUrl(accessToken)
      const opened = await openBrowser(url)
      if (!opened) {
        setErrorSource('portal')
        setErrorMsg(
          `Não foi possível abrir o navegador. Abra este endereço manualmente: ${url}`,
        )
        setStep('error')
        return
      }
      void startPolling()
    } catch (error) {
      setErrorSource('portal')
      setErrorMsg(
        describePurchaseError(
          error,
          'Não foi possível abrir o portal de pagamento.',
        ).message,
      )
      setStep('error')
    }
  }, [accessToken, startPolling])

  if (step === 'loading') return null

  if (step === 'warning') {
    return <Text color="yellow">{getPastDueWarningMessage(pastDueGroups)}</Text>
  }

  if (step === 'notice') {
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column" gap={1}>
          <Text color="yellow">⚠ Pagamento pendente</Text>
          <Text>O acesso aos modelos está bloqueado até a regularização.</Text>
          {pastDueGroups.map((subscription) => {
            const groupName = subscription.group?.name ?? subscription.groupId
            const price = subscription.group
              ? ` — ${formatPrice(subscription.group.priceCents, subscription.group.currency)}/${subscription.group.billingInterval === 'year' ? 'ano' : 'mês'}`
              : ''
            return (
              <Text key={subscription.id}>
                • {groupName}
                {price}
              </Text>
            )
          })}
        </Box>
        <Select
          options={[
            { label: 'Regularizar agora', value: 'pay' },
            { label: 'Sair sem comprar outro plano', value: 'exit' },
          ]}
          onChange={(value: string) => {
            if (value === 'pay') void handlePay()
            else onDone(false)
          }}
        />
      </Box>
    )
  }

  if (step === 'opening') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text>Abrindo o portal de pagamento…</Text>
        <Spinner />
      </Box>
    )
  }

  if (step === 'polling') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text>Aguardando a confirmação do pagamento…</Text>
        <Spinner />
      </Box>
    )
  }

  if (step === 'success') {
    return <Text color="green">✓ Pagamento confirmado. Acesso restaurado.</Text>
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text color="red">Erro: {errorMsg}</Text>
      <Select
        options={[
          { label: 'Tentar novamente', value: 'retry' },
          { label: 'Sair', value: 'exit' },
        ]}
        onChange={(value: string) => {
          if (value === 'exit') onDone(false)
          else if (errorSource === 'loading') void loadSubscriptions()
          else if (errorSource === 'polling') void startPolling()
          else void handlePay()
        }}
      />
    </Box>
  )
}

export async function showPastDueNotice(accessToken: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const subscriptions = await fetchSubscriptions(accessToken)
    return getPastDueAccessDecision(subscriptions).kind !== 'block'
  }

  return new Promise<boolean>((resolve) => {
    let instance: { unmount: () => void } | null = null
    let pendingResult: boolean | null = null
    const finish = (result: boolean) => {
      if (!instance) {
        pendingResult = result
        return
      }
      instance.unmount()
      setTimeout(() => resolve(result), 50)
    }

    render(<PastDueView accessToken={accessToken} onDone={finish} />).then(
      (created) => {
        instance = created
        if (pendingResult !== null) finish(pendingResult)
      },
    )
  })
}
