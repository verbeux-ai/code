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
    setErrorMsg('Timeout exceeded. Your payment may not have been processed.')
    setStep('error')
  }, [accessToken, onDone])

  const handlePay = useCallback(async () => {
    setStep('opening')
    try {
      const url = await fetchPortalUrl(accessToken)
      if (!url) {
        setErrorMsg('Could not open the payment portal.')
        setStep('error')
        return
      }
      const opened = await openBrowser(url)
      if (!opened) {
        setErrorMsg('Could not open the browser. Open this link manually: ' + url)
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
    return null
  }

  if (step === 'notice') {
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column" gap={1}>
          <Text color="yellow">⚠ Payment overdue</Text>
          <Text>Your access to models is blocked until payment is resolved.</Text>
          {pastDueGroups.map(sub => {
            const groupName = sub.group?.name ?? sub.groupId
            let priceDesc = ''
            if (sub.group) {
              priceDesc = ` — ${formatPrice(sub.group.priceCents, sub.group.currency)}/${sub.group.billingInterval === 'year' ? 'year' : 'month'}`
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
            { label: 'Pay now', value: 'pay' },
            { label: 'Skip', value: 'skip' },
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
        <Text>Opening payment portal...</Text>
        <Spinner />
      </Box>
    )
  }

  if (step === 'polling') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text>Waiting for payment confirmation...</Text>
        <Spinner />
      </Box>
    )
  }

  if (step === 'success') {
    return <Text color="green">✓ Payment confirmed! Access restored.</Text>
  }

  // error
  return (
    <Box flexDirection="column" gap={1}>
      <Text color="red">Erro: {errorMsg}</Text>
      <Select
        options={[
          { label: 'Try again', value: 'retry' },
          { label: 'Skip', value: 'skip' },
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
