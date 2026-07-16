import { toString as qrToString } from 'qrcode'
import React, { useCallback, useState } from 'react'
import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js'

import { Select } from '../../components/CustomSelect/select.js'
import { Spinner } from '../../components/Spinner.js'
import TextInput from '../../components/TextInput.js'
import { Box, render, Text, useInput } from '../../ink.js'
import { openBrowser } from '../../utils/browser.js'
import { errorMessage } from '../../utils/errors.js'
import { fetchVerbooModels } from '../api/verbooModels.js'
import {
  createCheckoutSession,
  confirmCardlessTrial,
  getWhatsAppProfile,
  isGroupSubscriptionActive,
  isWooviSubscriptionActive,
  resendCardlessTrialCode,
  startCardlessTrial,
  type CardlessTrialResult,
  type PaymentMethod,
  type WhatsAppProfile,
  type WooviCheckoutData,
} from '../api/verbooCheckout.js'
import {
  fetchMarketplaceGroups,
  type MarketplaceGroup,
} from '../api/verbooMarketplace.js'
import { isValidCPF, onlyDigits } from './purchaseValidation.js'

const POLL_INTERVAL_MS = 3_000
const POLL_TIMEOUT_MS = 5 * 60 * 1_000
const COLS = 3
const INPUT_COLUMNS = 48

function formatCPF(value: string): string {
  const digits = onlyDigits(value).slice(0, 11)
  if (digits.length <= 3) return digits
  if (digits.length <= 6) return `${digits.slice(0, 3)}.${digits.slice(3)}`
  if (digits.length <= 9) {
    return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`
  }
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`
}

function formatPhone(value: string): string {
  const digits = onlyDigits(value).slice(0, 11)
  if (digits.length <= 2) return digits.length > 0 ? `(${digits}` : ''
  if (digits.length <= 7) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`
}

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
  for (const instance of group.instances) {
    for (const model of instance.models) names.add(model.modelName)
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

function paymentProviderLabel(group: MarketplaceGroup): string {
  if (supportsCardlessTrial(group)) return 'Trial via WhatsApp'
  switch (group.paymentProvider) {
    case 'woovi':
      return 'Pix Automático'
    case 'both':
      return 'Cartão ou Pix'
    default:
      return 'Cartão'
  }
}

function supportsCardlessTrial(group: MarketplaceGroup): boolean {
  return Boolean(
    group.trialDays && group.trialDays > 0 &&
    group.trialPaymentMethodRequired === false &&
    group.paymentProvider !== 'woovi',
  )
}

type CardlessPhoneFormProps = {
  initialCountry?: string
  onCancel: () => void
  onSubmit: (phone: string, country: CountryCode) => void
}

function CardlessPhoneForm({ initialCountry, onCancel, onSubmit }: CardlessPhoneFormProps): React.ReactNode {
  const initial = getCountries().includes(initialCountry as CountryCode) ? initialCountry as CountryCode : 'BR'
  const [country, setCountry] = useState<CountryCode>(initial)
  const [choosingCountry, setChoosingCountry] = useState(true)
  const [phone, setPhone] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [cursorOffset, setCursorOffset] = useState(0)
  const names = React.useMemo(() => new Intl.DisplayNames(['pt-BR'], { type: 'region' }), [])
  const countries = React.useMemo(
    () => getCountries()
      .map(value => ({
        value,
        label: `${names.of(value) ?? value} (+${getCountryCallingCode(value)})`,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR')),
    [names],
  )

  if (choosingCountry) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>País do WhatsApp</Text>
        <Select
          options={countries}
          defaultFocusValue={country}
          visibleOptionCount={8}
          onCancel={onCancel}
          onChange={(value: CountryCode) => {
            setCountry(value)
            setChoosingCountry(false)
          }}
        />
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Confirme seu WhatsApp para iniciar o trial sem cartão</Text>
      <Text dimColor>{names.of(country)} (+{getCountryCallingCode(country)})</Text>
      <TextInput
        value={phone}
        cursorOffset={cursorOffset}
        onChangeCursorOffset={setCursorOffset}
        onChange={value => { setPhone(value); setError(null) }}
        onSubmit={value => {
          const parsed = parsePhoneNumberFromString(value, country)
          if (!parsed?.isValid()) {
            setError('Informe um número de WhatsApp válido.')
            return
          }
          onSubmit(parsed.number, country)
        }}
        onExit={() => setChoosingCountry(true)}
        columns={INPUT_COLUMNS}
        placeholder="Número com DDD"
        focus
        showCursor
        multiline={false}
      />
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>Enter para enviar o código · Esc para trocar o país</Text>
    </Box>
  )
}

type CardlessCodeFormProps = {
  verification: CardlessTrialResult
  onConfirm: (code: string) => void
  onResend: () => void
}

function CardlessCodeForm({ verification, onConfirm, onResend }: CardlessCodeFormProps): React.ReactNode {
  const [code, setCode] = useState('')
  const [actions, setActions] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cursorOffset, setCursorOffset] = useState(0)

  if (actions) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Opções da verificação</Text>
        <Select
          options={[
            { label: 'Digitar o código', value: 'code' },
            { label: 'Reenviar código', value: 'resend' },
          ]}
          onCancel={() => setActions(false)}
          onChange={(value: string) => {
            if (value === 'resend') onResend()
            else setActions(false)
          }}
        />
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Código de verificação</Text>
      <Text dimColor>Enviamos 6 dígitos para {verification.maskedPhone ?? 'seu WhatsApp'}.</Text>
      <TextInput
        value={code}
        cursorOffset={cursorOffset}
        onChangeCursorOffset={setCursorOffset}
        onChange={value => { setCode(onlyDigits(value).slice(0, 6)); setError(null) }}
        onSubmit={value => {
          const normalized = onlyDigits(value)
          if (normalized.length !== 6) {
            setError('Digite os 6 dígitos do código.')
            return
          }
          onConfirm(normalized)
        }}
        onExit={() => setActions(true)}
        columns={INPUT_COLUMNS}
        placeholder="123456"
        focus
        showCursor
        multiline={false}
      />
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>Enter para confirmar · Esc para reenviar ou usar cartão</Text>
    </Box>
  )
}

type WooviPayerFormProps = {
  onCancel: () => void
  onSubmit: (data: WooviCheckoutData) => void
}

function WooviPayerForm({ onCancel, onSubmit }: WooviPayerFormProps): React.ReactNode {
  const [field, setField] = useState<'cpf' | 'phone'>('cpf')
  const [cpf, setCPF] = useState('')
  const [phone, setPhone] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [cpfCursorOffset, setCPFCursorOffset] = useState(0)
  const [phoneCursorOffset, setPhoneCursorOffset] = useState(0)

  const submitCPF = (value: string) => {
    const formatted = formatCPF(value)
    setCPF(formatted)
    if (!isValidCPF(formatted)) {
      setError('Informe um CPF válido para continuar.')
      return
    }
    setError(null)
    setField('phone')
  }

  const submitPhone = (value: string) => {
    const formatted = formatPhone(value)
    setPhone(formatted)
    const digits = onlyDigits(formatted)
    if (digits.length !== 11 || digits[2] !== '9') {
      setError('Informe um celular brasileiro com DDD.')
      return
    }
    onSubmit({ taxId: onlyDigits(cpf), phone: digits })
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Dados para o Pix Automático</Text>
      <Text dimColor>
        A Woovi precisa destes dados para criar a recorrência. Eles não são salvos no seu computador.
      </Text>
      {field === 'cpf' ? (
        <Box flexDirection="column">
          <Text>CPF</Text>
          <TextInput
            value={cpf}
            cursorOffset={cpfCursorOffset}
            onChangeCursorOffset={setCPFCursorOffset}
            onChange={value => {
              setError(null)
              setCPF(formatCPF(value))
            }}
            onSubmit={submitCPF}
            onExit={onCancel}
            columns={INPUT_COLUMNS}
            placeholder="000.000.000-00"
            focus
            showCursor
            multiline={false}
          />
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text>Celular com DDD</Text>
          <TextInput
            value={phone}
            cursorOffset={phoneCursorOffset}
            onChangeCursorOffset={setPhoneCursorOffset}
            onChange={value => {
              setError(null)
              setPhone(formatPhone(value))
            }}
            onSubmit={submitPhone}
            onExit={onCancel}
            columns={INPUT_COLUMNS}
            placeholder="(11) 99999-9999"
            focus
            showCursor
            multiline={false}
          />
        </Box>
      )}
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>Enter para continuar · Esc para voltar</Text>
    </Box>
  )
}

type WooviPaymentViewProps = {
  accessToken: string
  qrCode: string
  subscriptionId: string
  onCancel: () => void
  onConfirmed: () => void
}

function WooviPaymentView({
  accessToken,
  qrCode,
  subscriptionId,
  onCancel,
  onConfirmed,
}: WooviPaymentViewProps): React.ReactNode {
  const [qr, setQR] = useState('')
  const [timedOut, setTimedOut] = useState(false)
  const [attempt, setAttempt] = useState(0)

  React.useEffect(() => {
    let cancelled = false
    qrToString(qrCode, {
      type: 'utf8',
      errorCorrectionLevel: 'M',
      small: true,
    })
      .then(value => {
        if (!cancelled) setQR(value)
      })
      .catch(() => {
        if (!cancelled) setQR('')
      })
    return () => {
      cancelled = true
    }
  }, [qrCode])

  React.useEffect(() => {
    let cancelled = false
    const start = Date.now()
    setTimedOut(false)

    const poll = async () => {
      while (!cancelled && Date.now() - start < POLL_TIMEOUT_MS) {
        try {
          if (await isWooviSubscriptionActive(accessToken, subscriptionId)) {
            if (!cancelled) onConfirmed()
            return
          }
        } catch {
          // A confirmação do banco é assíncrona; tenta novamente até o timeout.
        }
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
      }
      if (!cancelled) setTimedOut(true)
    }

    void poll()
    return () => {
      cancelled = true
    }
  }, [accessToken, attempt, onConfirmed, subscriptionId])

  useInput(
    (_input, key) => {
      if (key.escape) onCancel()
    },
    { isActive: !timedOut },
  )

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Escaneie o QR Code para aprovar o Pix Automático</Text>
      {qr ? (
        <Box flexDirection="column">
          {qr
            .split('\n')
            .filter(line => line.length > 0)
            .map((line, index) => (
              <Text key={index}>{line}</Text>
            ))}
        </Box>
      ) : (
        <Spinner />
      )}
      <Text dimColor>Pix copia e cola:</Text>
      <Text wrap="wrap">{qrCode}</Text>
      {timedOut ? (
        <Box flexDirection="column" gap={1}>
          <Text color="warning">Ainda não recebemos a confirmação. O QR continua válido.</Text>
          <Select
            options={[
              { label: 'Verificar novamente', value: 'retry' },
              { label: 'Fechar', value: 'close' },
            ]}
            onChange={(value: string) => {
              if (value === 'retry') setAttempt(current => current + 1)
              else onCancel()
            }}
          />
        </Box>
      ) : (
        <Box>
          <Spinner />
          <Text>Aguardando a aprovação no seu banco…</Text>
        </Box>
      )}
    </Box>
  )
}

type Step =
  | 'splash'
  | 'loading-plans'
  | 'plans'
  | 'plan-detail'
  | 'payment-method'
  | 'woovi-form'
  | 'whatsapp-choice'
  | 'whatsapp-phone'
  | 'whatsapp-code'
  | 'cardless-activating'
  | 'cardless-polling'
  | 'checkout'
  | 'polling'
  | 'woovi-qr'
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
  const [wooviPayment, setWooviPayment] = useState<{
    qrCode: string
    subscriptionId: string
  } | null>(null)
  const [whatsappProfile, setWhatsAppProfile] = useState<WhatsAppProfile | null>(null)
  const [cardlessVerification, setCardlessVerification] = useState<CardlessTrialResult | null>(null)
  const plansRequestRef = React.useRef<AbortController | null>(null)

  const cancelPlansLoading = useCallback(() => {
    plansRequestRef.current?.abort()
    plansRequestRef.current = null
    setStep('splash')
  }, [])

  React.useEffect(
    () => () => {
      plansRequestRef.current?.abort()
    },
    [],
  )

  const fetchPlans = useCallback(async () => {
    plansRequestRef.current?.abort()
    const controller = new AbortController()
    plansRequestRef.current = controller
    setErrorMsg(null)
    setStep('loading-plans')
    try {
      const groups = await fetchMarketplaceGroups({
        force: true,
        signal: controller.signal,
      })
      if (plansRequestRef.current !== controller) return
      if (groups.length === 0) {
        setErrorMsg('Nenhum plano está disponível no momento. Tente novamente mais tarde.')
        setStep('error')
        return
      }
      setPlans(groups)
      setFocusIndex(0)
      setStep('plans')
    } catch (error) {
      if (controller.signal.aborted || plansRequestRef.current !== controller) {
        return
      }
      setErrorMsg(`Não foi possível carregar os planos: ${errorMessage(error)}`)
      setStep('error')
    } finally {
      if (plansRequestRef.current === controller) {
        plansRequestRef.current = null
      }
    }
  }, [])

  const startStripePolling = useCallback(async () => {
    const startTime = Date.now()
    while (Date.now() - startTime < POLL_TIMEOUT_MS) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
      try {
        const models = await fetchVerbooModels(accessToken, { force: true })
        if (models.length > 0) {
          setStep('success')
          setTimeout(() => onDone(true), 1_500)
          return
        }
      } catch (error) {
        setErrorMsg(
          `Não foi possível verificar a liberação dos modelos: ${errorMessage(error)}`,
        )
        setStep('error')
        return
      }
    }
    setErrorMsg('O pagamento ainda não foi confirmado. Verifique o checkout e tente novamente.')
    setStep('error')
  }, [accessToken, onDone])

  const startCardlessPolling = useCallback(async (groupId: string) => {
    const startTime = Date.now()
    setStep('cardless-polling')
    while (Date.now() - startTime < POLL_TIMEOUT_MS) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
      try {
        if (!(await isGroupSubscriptionActive(accessToken, groupId))) continue
        const models = await fetchVerbooModels(accessToken, { force: true })
        if (models.length > 0) {
          setStep('success')
          setTimeout(() => onDone(true), 1_500)
          return
        }
      } catch {
        // Stripe e o router são atualizados por webhook; continua até o timeout.
      }
    }
    setErrorMsg('O trial foi ativado, mas os modelos ainda não foram liberados. Execute o Verboo novamente em instantes.')
    setStep('error')
  }, [accessToken, onDone])

  const prepareCardlessTrial = useCallback(async (group: MarketplaceGroup) => {
    setSelectedPlan(group)
    setErrorMsg(null)
    setStep('cardless-activating')
    try {
      const profile = await getWhatsAppProfile(accessToken)
      setWhatsAppProfile(profile)
    } catch {
      // O usuário ainda pode informar um número novo.
      setWhatsAppProfile(null)
    }
    setStep('whatsapp-choice')
  }, [accessToken])

  const handleCardlessStart = useCallback(async (
    group: MarketplaceGroup,
    useVerifiedPhone: boolean,
    phone?: string,
    countryCode?: CountryCode,
  ) => {
    setErrorMsg(null)
    setStep('cardless-activating')
    try {
      const result = await startCardlessTrial(accessToken, group.id, {
        useVerifiedPhone,
        phone,
        countryCode,
      })
      if (result.mode === 'verification_required') {
        setCardlessVerification(result)
        setStep('whatsapp-code')
      } else {
        void startCardlessPolling(group.id)
      }
    } catch (error) {
      setErrorMsg(`Não foi possível iniciar sem cartão: ${errorMessage(error)}`)
      setStep('whatsapp-choice')
    }
  }, [accessToken, startCardlessPolling])

  const handleCardlessConfirm = useCallback(async (group: MarketplaceGroup, code: string) => {
    if (!cardlessVerification?.verificationId) return
    setErrorMsg(null)
    setStep('cardless-activating')
    try {
      const result = await confirmCardlessTrial(accessToken, cardlessVerification.verificationId, code)
      if (result.mode === 'trial_activated') {
        void startCardlessPolling(group.id)
      } else {
        setCardlessVerification(result)
        setStep('whatsapp-code')
      }
    } catch (error) {
      setErrorMsg(`Não foi possível confirmar o código: ${errorMessage(error)}`)
      setStep('whatsapp-code')
    }
  }, [accessToken, cardlessVerification, startCardlessPolling])

  const handleCardlessResend = useCallback(async () => {
    if (!cardlessVerification?.verificationId) return
    setErrorMsg(null)
    setStep('cardless-activating')
    try {
      const result = await resendCardlessTrialCode(accessToken, cardlessVerification.verificationId)
      setCardlessVerification(result)
      setStep('whatsapp-code')
    } catch (error) {
      setErrorMsg(`Não foi possível reenviar o código: ${errorMessage(error)}`)
      setStep('whatsapp-code')
    }
  }, [accessToken, cardlessVerification])

  const handleCheckout = useCallback(
    async (
      group: MarketplaceGroup,
      paymentMethod: PaymentMethod,
      woovi?: WooviCheckoutData,
    ) => {
      setStep('checkout')
      try {
        const result = await createCheckoutSession(accessToken, group.id, {
          paymentMethod,
          woovi,
        })
        if (result.mode === 'reactivated') {
          setStep('success')
          setTimeout(() => onDone(true), 1_500)
          return
        }
        if (result.mode === 'woovi') {
          setWooviPayment({
            qrCode: result.wooviQrCode,
            subscriptionId: result.wooviSubscriptionId,
          })
          setStep('woovi-qr')
          return
        }
        await openBrowser(result.url)
        setStep('polling')
        void startStripePolling()
      } catch (error) {
        setErrorMsg((error as Error).message)
        setStep('error')
      }
    },
    [accessToken, onDone, startStripePolling],
  )

  const startPlanCheckout = (group: MarketplaceGroup) => {
    if (supportsCardlessTrial(group)) {
      void prepareCardlessTrial(group)
    } else if (group.paymentProvider === 'both') {
      setStep('payment-method')
    } else if (group.paymentProvider === 'woovi') {
      setStep('woovi-form')
    } else {
      void handleCheckout(group, 'stripe')
    }
  }

  const handleWooviConfirmed = useCallback(async () => {
    try {
      const models = await fetchVerbooModels(accessToken, { force: true })
      if (models.length === 0) {
        setErrorMsg('Pagamento confirmado, mas os modelos ainda não foram liberados. Aguarde alguns segundos e execute o Verboo novamente.')
        setStep('error')
        return
      }
      setStep('success')
      setTimeout(() => onDone(true), 1_500)
    } catch (error) {
      setErrorMsg(
        `Pagamento confirmado, mas não foi possível verificar os modelos: ${errorMessage(error)}`,
      )
      setStep('error')
    }
  }, [accessToken, onDone])

  useInput(
    (_input, key) => {
      if (step === 'loading-plans') {
        if (key.escape) cancelPlansLoading()
        return
      }
      if (step !== 'plans' || plans.length === 0) return
      if (key.leftArrow) setFocusIndex(index => Math.max(0, index - 1))
      else if (key.rightArrow) setFocusIndex(index => Math.min(plans.length - 1, index + 1))
      else if (key.upArrow) setFocusIndex(index => Math.max(0, index - COLS))
      else if (key.downArrow) setFocusIndex(index => Math.min(plans.length - 1, index + COLS))
      else if (key.return) {
        const plan = plans[focusIndex]
        if (plan) {
          setSelectedPlan(plan)
          setStep('plan-detail')
        }
      } else if (key.escape) setStep('splash')
    },
    { isActive: step === 'plans' || step === 'loading-plans' },
  )

  switch (step) {
    case 'splash':
      return (
        <Box flexDirection="column" gap={1}>
          <Text>Nenhum modelo disponível na sua conta.</Text>
          <Select
            options={[
              { label: 'Fechar', value: 'fechar' },
              { label: 'Ver planos', value: 'planos' },
            ]}
            onChange={(value: string) => {
              if (value === 'fechar') onDone(false)
              else void fetchPlans()
            }}
          />
        </Box>
      )

    case 'loading-plans':
      return (
        <Box flexDirection="column" gap={1}>
          <Text>Buscando planos disponíveis…</Text>
          <Spinner />
          <Text dimColor>Esc para cancelar</Text>
        </Box>
      )

    case 'plans': {
      const rows: MarketplaceGroup[][] = []
      for (let index = 0; index < plans.length; index += COLS) {
        rows.push(plans.slice(index, index + COLS))
      }
      const focusedRow = Math.floor(focusIndex / COLS)
      const focusedCol = focusIndex % COLS

      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Planos disponíveis</Text>
          <Text dimColor>Setas para navegar, Enter para selecionar, Esc para voltar</Text>
          <Box flexDirection="column" gap={1}>
            {rows.map((row, rowIndex) => (
              <Box key={rowIndex} flexDirection="row" gap={2}>
                {row.map((plan, columnIndex) => {
                  const focused = rowIndex === focusedRow && columnIndex === focusedCol
                  return (
                    <Box
                      key={plan.id}
                      flexDirection="column"
                      borderStyle={focused ? 'bold' : 'round'}
                      borderColor={focused ? 'claude' : undefined}
                      paddingX={1}
                      flexGrow={1}
                      width="33%"
                    >
                      <Text bold wrap="truncate">{plan.name}</Text>
                      <Text>{formatPrice(plan.priceCents, plan.currency)}{formatInterval(plan.billingInterval)}</Text>
                      <Text dimColor wrap="truncate" title={getModelNames(plan)}>{getModelNames(plan)}</Text>
                      <Text dimColor>{getSlotsInfo(plan)}</Text>
                      <Text dimColor>{paymentProviderLabel(plan)}</Text>
                      {plan.trialDays && plan.trialDays > 0 && plan.paymentProvider !== 'woovi' ? (
                        <Text color="success">
                          {plan.trialDays} dias de trial{plan.trialPaymentMethodRequired === false ? ' · sem cartão' : ''}
                        </Text>
                      ) : null}
                    </Box>
                  )
                })}
                {row.length < COLS
                  ? Array.from({ length: COLS - row.length }).map((_, index) => (
                      <Box key={`empty-${index}`} flexGrow={1} width="33%" />
                    ))
                  : null}
              </Box>
            ))}
          </Box>
        </Box>
      )
    }

    case 'plan-detail': {
      const plan = selectedPlan!
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold>{plan.name}</Text>
            <Text>{formatPrice(plan.priceCents, plan.currency)}{formatInterval(plan.billingInterval)}</Text>
            <Text dimColor>Modelos: {getModelNames(plan)}</Text>
            <Text dimColor>Assinantes: {getSlotsInfo(plan)}</Text>
            <Text dimColor>Pagamento: {paymentProviderLabel(plan)}</Text>
            {plan.trialDays && plan.trialDays > 0 && plan.paymentProvider !== 'woovi' ? (
              <Text color="success">
                Trial: {plan.trialDays} dias{plan.trialPaymentMethodRequired === false ? ' · sem cartão' : ''}
              </Text>
            ) : null}
          </Box>
          <Select
            options={[
              { label: 'Assinar agora', value: 'confirm' },
              { label: 'Voltar', value: 'back' },
            ]}
            onChange={(value: string) => {
              if (value === 'confirm') startPlanCheckout(plan)
              else setStep('plans')
            }}
          />
        </Box>
      )
    }

    case 'payment-method':
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Como deseja pagar?</Text>
          <Select
            options={[
              { label: 'Cartão de crédito', value: 'stripe', description: 'Checkout seguro da Stripe no navegador' },
              { label: 'Pix Automático', value: 'woovi', description: 'Aprove a recorrência pelo QR Code no terminal' },
              { label: 'Voltar', value: 'back' },
            ]}
            onChange={(value: string) => {
              if (value === 'back') setStep('plan-detail')
              else if (value === 'woovi') setStep('woovi-form')
              else if (selectedPlan) void handleCheckout(selectedPlan, 'stripe')
            }}
          />
        </Box>
      )

    case 'woovi-form':
      return (
        <WooviPayerForm
          onCancel={() => setStep(selectedPlan?.paymentProvider === 'both' ? 'payment-method' : 'plan-detail')}
          onSubmit={data => {
            if (selectedPlan) void handleCheckout(selectedPlan, 'woovi', data)
          }}
        />
      )

    case 'whatsapp-choice': {
      const plan = selectedPlan!
      const options = [
        ...(whatsappProfile?.verified
          ? [{
              label: `Usar WhatsApp verificado (${whatsappProfile.maskedPhone ?? 'número salvo'})`,
              value: 'verified',
              description: 'Ativa sem enviar um novo código',
            }]
          : []),
        { label: 'Verificar um número de WhatsApp', value: 'new', description: 'Receba um código de 6 dígitos' },
        { label: 'Voltar', value: 'back' },
      ]
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Trial de {plan.trialDays} dias sem cartão</Text>
          <Text dimColor>
            A assinatura será criada na Stripe e cancelada no fim do trial se você não adicionar um cartão.
          </Text>
          {errorMsg ? <Text color="red">{errorMsg}</Text> : null}
          <Select
            options={options}
            onChange={(value: string) => {
              if (value === 'verified') void handleCardlessStart(plan, true)
              else if (value === 'new') setStep('whatsapp-phone')
              else setStep('plan-detail')
            }}
          />
        </Box>
      )
    }

    case 'whatsapp-phone':
      return (
        <CardlessPhoneForm
          initialCountry={whatsappProfile?.countryCode}
          onCancel={() => setStep('whatsapp-choice')}
          onSubmit={(phone, country) => {
            if (selectedPlan) void handleCardlessStart(selectedPlan, false, phone, country)
          }}
        />
      )

    case 'whatsapp-code':
      return cardlessVerification && selectedPlan ? (
        <Box flexDirection="column" gap={1}>
          {errorMsg ? <Text color="red">{errorMsg}</Text> : null}
          <CardlessCodeForm
            verification={cardlessVerification}
            onConfirm={code => void handleCardlessConfirm(selectedPlan, code)}
            onResend={() => void handleCardlessResend()}
          />
        </Box>
      ) : null

    case 'cardless-activating':
      return (
        <Box flexDirection="column" gap={1}>
          <Text>Preparando o trial sem cartão…</Text>
          <Spinner />
        </Box>
      )

    case 'cardless-polling':
      return (
        <Box flexDirection="column" gap={1}>
          <Text>Trial ativado. Aguardando a liberação dos modelos…</Text>
          <Spinner />
        </Box>
      )

    case 'checkout':
      return (
        <Box flexDirection="column" gap={1}>
          <Text>Criando checkout…</Text>
          <Spinner />
        </Box>
      )

    case 'polling':
      return (
        <Box flexDirection="column" gap={1}>
          <Text>Aguardando confirmação do pagamento no navegador…</Text>
          <Spinner />
        </Box>
      )

    case 'woovi-qr':
      return wooviPayment ? (
        <WooviPaymentView
          accessToken={accessToken}
          qrCode={wooviPayment.qrCode}
          subscriptionId={wooviPayment.subscriptionId}
          onCancel={() => onDone(false)}
          onConfirmed={() => void handleWooviConfirmed()}
        />
      ) : null

    case 'success':
      return <Text color="success">Assinatura confirmada! Modelos disponíveis.</Text>

    case 'error':
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="red">Erro: {errorMsg}</Text>
          <Select
            options={[
              { label: 'Tentar novamente', value: 'retry' },
              { label: 'Fechar', value: 'fechar' },
            ]}
            onChange={(value: string) => {
              if (value === 'fechar') onDone(false)
              else void fetchPlans()
            }}
          />
        </Box>
      )
  }
}

export async function showNoModelsFlow(accessToken: string): Promise<boolean> {
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
    ).then(created => {
      instance = created
    })
  })
}
