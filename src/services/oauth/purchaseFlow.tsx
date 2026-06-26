import React, { useCallback, useState } from 'react'

import { Select } from '../../components/CustomSelect/select.js'
import { Spinner } from '../../components/Spinner.js'
import { Box, render, Text, useInput } from '../../ink.js'
import { openBrowser } from '../../utils/browser.js'
import { fetchVerbooModels } from '../api/verbooModels.js'
import {
  createCheckoutSession,
  type CheckoutResult,
} from '../api/verbooCheckout.js'
import {
  clearMarketplaceCache,
  fetchMarketplaceGroups,
  type MarketplaceGroup,
} from '../api/verbooMarketplace.js'

const POLL_INTERVAL_MS = 3_000
const POLL_TIMEOUT_MS = 5 * 60 * 1_000
const COLS = 3

function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100)
}

function formatInterval(interval: string): string {
  return interval === 'year' ? '/ano' : '/mes'
}

function getModelNames(group: MarketplaceGroup): string {
  const names = new Set<string>()
  for (const inst of group.instances) {
    for (const m of inst.models) {
      names.add(m.modelName)
    }
  }
  return [...names].join(', ')
}

function getSlotsInfo(group: MarketplaceGroup): string {
  const current = group.memberCount ?? 0
  if (group.subscriberLimit != null) {
    const remaining = group.subscriberLimit - current
    if (remaining <= 0) return 'Grupo lotado'
    return `${current}/${group.subscriberLimit} assinantes`
  }
  return `${current} assinantes`
}

function getPlanPriceDescription(group: MarketplaceGroup): string {
  const price = formatPrice(group.priceCents, group.currency)
  const interval = formatInterval(group.billingInterval)
  const models = getModelNames(group)
  const slots = getSlotsInfo(group)
  let desc = `${price}${interval}`
  if (models) desc += ` \u00B7 ${models}`
  desc += ` \u00B7 ${slots}`
  if (group.trialDays && group.trialDays > 0) {
    desc += ` \u00B7 ${group.trialDays} dias de trial`
  }
  return desc
}

type Step =
  | 'splash'
  | 'loading-plans'
  | 'plans'
  | 'plan-detail'
  | 'checkout'
  | 'polling'
  | 'success'
  | 'error'

export function PurchaseFlowView({
  accessToken,
  onDone,
}: {
  accessToken: string
  onDone: (result: boolean) => void
}) {
  const [step, setStep] = useState<Step>('splash')
  const [plans, setPlans] = useState<MarketplaceGroup[]>([])
  const [selectedPlan, setSelectedPlan] = useState<MarketplaceGroup | null>(null)
  const [focusIndex, setFocusIndex] = useState(0)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const fetchPlans = useCallback(async () => {
    setStep('loading-plans')
    clearMarketplaceCache()
    const groups = await fetchMarketplaceGroups({ force: true })
    if (groups.length === 0) {
      setStep('splash')
    } else {
      setPlans(groups)
      setFocusIndex(0)
      setStep('plans')
    }
  }, [])

  const startPolling = useCallback(async () => {
    const startTime = Date.now()
    while (Date.now() - startTime < POLL_TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
      try {
        const models = await fetchVerbooModels(accessToken, { force: true })
        if (models.length > 0) {
          setStep('success')
          setTimeout(() => onDone(true), 1_500)
          return
        }
      } catch {
        // retry
      }
    }
    onDone(false)
  }, [accessToken, onDone])

  const handleCheckout = useCallback(
    async (group: MarketplaceGroup) => {
      setStep('checkout')
      try {
        const result = await createCheckoutSession(accessToken, group.id)
        if (result.mode === 'trial') {
          setStep('success')
          setTimeout(() => onDone(true), 1_500)
          return
        }
        if (result.mode === 'woovi') {
          setStep('checkout')
          setErrorMsg(result.wooviQrCode)
          setStep('polling')
          void startPolling()
          return
        }
        await openBrowser(result.url)
        setStep('polling')
        void startPolling()
      } catch (e) {
        setErrorMsg((e as Error).message)
        setStep('error')
      }
    },
    [accessToken, onDone, startPolling],
  )

  // Keyboard navigation for the plan grid
  useInput(
    (input, key) => {
      if (step !== 'plans' || plans.length === 0) return

      if (key.leftArrow) {
        setFocusIndex(i => Math.max(0, i - 1))
      } else if (key.rightArrow) {
        setFocusIndex(i => Math.min(plans.length - 1, i + 1))
      } else if (key.upArrow) {
        setFocusIndex(i => Math.max(0, i - COLS))
      } else if (key.downArrow) {
        setFocusIndex(i => Math.min(plans.length - 1, i + COLS))
      } else if (key.return) {
        const plan = plans[focusIndex]
        if (plan) {
          setSelectedPlan(plan)
          setStep('plan-detail')
        }
      } else if (key.escape) {
        setStep('splash')
      }
    },
    { isActive: step === 'plans' },
  )

  switch (step) {
    case 'splash':
      return (
        <Box flexDirection="column" gap={1}>
          <Text>Nenhum modelo disponivel na sua conta.</Text>
          <Select
            options={[
              { label: 'Fechar', value: 'fechar' },
              { label: 'Ver Planos', value: 'planos' },
            ]}
            onChange={(v: string) => {
              if (v === 'fechar') onDone(false)
              else void fetchPlans()
            }}
          />
        </Box>
      )

    case 'loading-plans':
      return (
        <Box flexDirection="column" gap={1}>
          <Text>Buscando planos disponiveis...</Text>
          <Spinner />
        </Box>
      )

    case 'plans': {
      // Grid layout: 3 plans per row
      const rows: MarketplaceGroup[][] = []
      for (let i = 0; i < plans.length; i += COLS) {
        rows.push(plans.slice(i, i + COLS))
      }
      const focusedRow = Math.floor(focusIndex / COLS)
      const focusedCol = focusIndex % COLS

      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Planos disponiveis</Text>
          <Text dimColor>Setas para navegar, Enter para selecionar, Esc para voltar</Text>
          <Box flexDirection="column" gap={1}>
            {rows.map((row, rowIdx) => (
              <Box key={rowIdx} flexDirection="row" gap={2}>
                {row.map((plan, colIdx) => {
                  const isFocused = rowIdx === focusedRow && colIdx === focusedCol
                  const price = formatPrice(plan.priceCents, plan.currency)
                  const interval = formatInterval(plan.billingInterval)
                  const models = getModelNames(plan)
                  const slots = getSlotsInfo(plan)

                  return (
                    <Box
                      key={plan.id}
                      flexDirection="column"
                      borderStyle={isFocused ? 'bold' : 'round'}
                      borderColor={isFocused ? 'claude' : undefined}
                      paddingX={1}
                      paddingY={0}
                      flexGrow={1}
                      width="33%"
                    >
                      <Text bold wrap="truncate">
                        {plan.name}
                      </Text>
                      <Text>
                        {price}{interval}
                      </Text>
                      <Text dimColor wrap="truncate" title={models}>
                        {models}
                      </Text>
                      <Text dimColor>{slots}</Text>
                      {plan.trialDays && plan.trialDays > 0 && (
                        <Text color="success">{plan.trialDays} dias trial</Text>
                      )}
                    </Box>
                  )
                })}
                {/* Fill empty slots in the last row */}
                {row.length < COLS &&
                  Array.from({ length: COLS - row.length }).map((_, i) => (
                    <Box
                      key={`empty-${i}`}
                      flexGrow={1}
                      width="33%"
                    />
                  ))}
              </Box>
            ))}
          </Box>
        </Box>
      )
    }

    case 'plan-detail': {
      const plan = selectedPlan!
      const price = formatPrice(plan.priceCents, plan.currency)
      const interval = formatInterval(plan.billingInterval)
      const models = getModelNames(plan)
      const slots = getSlotsInfo(plan)

      return (
        <Box flexDirection="column" gap={1}>
          <Box
            flexDirection="column"
            borderStyle="round"
            paddingX={1}
            paddingY={0}
            gap={0}
          >
            <Text bold>{plan.name}</Text>
            <Text>{price}{interval}</Text>
            <Box flexDirection="column" marginTop={1}>
              <Text>
                <Text dimColor>Modelos: </Text>
                {models}
              </Text>
              <Text>
                <Text dimColor>Assinantes: </Text>
                {slots}
              </Text>
              {plan.trialDays && plan.trialDays > 0 && (
                <Text>
                  <Text dimColor>Trial: </Text>
                  {plan.trialDays} dias
                </Text>
              )}
            </Box>
          </Box>
          <Select
            options={[
              { label: 'Assinar Agora', value: 'confirm' },
              { label: 'Voltar', value: 'back' },
            ]}
            onChange={(v: string) => {
              if (v === 'confirm') {
                void handleCheckout(plan)
              } else {
                setStep('plans')
              }
            }}
          />
        </Box>
      )
    }

    case 'checkout':
      return (
        <Box flexDirection="column" gap={1}>
          <Text>Abrindo checkout no navegador...</Text>
          <Spinner />
        </Box>
      )

    case 'polling':
      return (
        <Box flexDirection="column" gap={1}>
          <Text>Aguardando confirmacao do pagamento...</Text>
          <Spinner />
        </Box>
      )

    case 'success':
      return <Text>Pagamento confirmado! Modelos disponiveis.</Text>

    case 'error':
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="red">Erro: {errorMsg}</Text>
          <Select
            options={[
              { label: 'Tentar novamente', value: 'retry' },
              { label: 'Fechar', value: 'fechar' },
            ]}
            onChange={(v: string) => {
              if (v === 'fechar') onDone(false)
              else void fetchPlans()
            }}
          />
        </Box>
      )
  }
}

export async function showNoModelsFlow(
  accessToken: string,
): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    let instance: { unmount: () => void } | null = null

    render(
      <PurchaseFlowView
        accessToken={accessToken}
        onDone={(ok: boolean) => {
          instance?.unmount()
          setTimeout(() => resolve(ok), 50)
        }}
      />,
    ).then(inst => {
      instance = inst
    })
  })
}
