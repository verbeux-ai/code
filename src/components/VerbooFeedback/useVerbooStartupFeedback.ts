import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  fetchNextVerbooFeedback,
  finalizeVerbooFeedback,
  flushVerbooFeedbackOutbox,
  hasVerbooFeedbackReceipt,
  markVerbooFeedbackViewed,
  type VerbooFeedbackAnswer,
  type VerbooFeedbackOffer,
} from '../../services/api/verbooFeedback.js'
import { isPolicyAllowed, waitForPolicyLimitsToLoad } from '../../services/policyLimits/index.js'
import { isBareMode, isEnvTruthy } from '../../utils/envUtils.js'
import { isTelemetryDisabled } from '../../utils/privacyLevel.js'

export type StartupFeedbackEligibility = {
  enabled: boolean
  stdinTTY: boolean
  stdoutTTY: boolean
  entrypoint?: string
  isRemoteSession: boolean
  hasInitialPrompt: boolean
  isBare: boolean
  isCI: boolean
  telemetryDisabled: boolean
  policyAllowed: boolean
  inheritedSurveyDisabled: boolean
}

export function isStartupFeedbackEligible(options: StartupFeedbackEligibility): boolean {
  return options.enabled && options.stdinTTY && options.stdoutTTY && options.entrypoint === 'cli' && !options.isRemoteSession && !options.hasInitialPrompt && !options.isBare && !options.isCI && !options.telemetryDisabled && options.policyAllowed && !options.inheritedSurveyDisabled
}

type Props = {
  enabled: boolean
  isRemoteSession: boolean
  hasInitialPrompt: boolean
  inputValue: string
  setInputValue: (value: string) => void
  submitCount: number
  locale: 'pt' | 'en'
  modelId: string
  provider: string
}

export type VerbooStartupFeedbackState = {
  offer: VerbooFeedbackOffer | null
  questionIndex: number
  selectedOptionIds: ReadonlySet<string>
  thanks: boolean
  handleDigit: (digit: string) => void
  handleSubmit: (input: string) => boolean
  dismissForWork: () => void
}

export function useVerbooStartupFeedback({
  enabled,
  isRemoteSession,
  hasInitialPrompt,
  inputValue,
  setInputValue,
  submitCount,
  locale,
  modelId,
  provider,
}: Props): VerbooStartupFeedbackState {
  const [offer, setOffer] = useState<VerbooFeedbackOffer | null>(null)
  const [questionIndex, setQuestionIndex] = useState(0)
  const [answers, setAnswers] = useState<VerbooFeedbackAnswer[]>([])
  const [selectedOptionIds, setSelectedOptionIds] = useState<ReadonlySet<string>>(new Set())
  const [thanks, setThanks] = useState(false)
  const initialInput = useRef(inputValue)
  const initialSubmitCount = useRef(submitCount)
  const inputRef = useRef(inputValue)
  const submitCountRef = useRef(submitCount)
  const offerRef = useRef<VerbooFeedbackOffer | null>(null)
  const userActedRef = useRef(inputValue !== '' || submitCount > 0)
  const finalizingRef = useRef(false)
  const requestStartedRef = useRef(false)
  inputRef.current = inputValue
  submitCountRef.current = submitCount
  offerRef.current = offer

  const eligibleAtMount = useRef(isStartupFeedbackEligible({
    enabled,
    stdinTTY: process.stdin.isTTY === true,
    stdoutTTY: process.stdout.isTTY === true,
    entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
    isRemoteSession,
    hasInitialPrompt,
    isBare: isBareMode(),
    isCI: isEnvTruthy(process.env.CI),
    telemetryDisabled: isTelemetryDisabled(),
    policyAllowed: isPolicyAllowed('allow_product_feedback'),
    inheritedSurveyDisabled: isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY),
  })).current

  useEffect(() => {
    if (!eligibleAtMount || requestStartedRef.current) return
    requestStartedRef.current = true
    let cancelled = false
    void (async () => {
      await waitForPolicyLimitsToLoad()
      if (cancelled || isTelemetryDisabled() || !isPolicyAllowed('allow_product_feedback')) return
      await flushVerbooFeedbackOutbox()
      if (cancelled) return
      try {
        const next = await fetchNextVerbooFeedback({
          locale,
          modelId,
          provider: provider.toLowerCase(),
          cliVersion: MACRO.VERSION,
          platform: process.platform,
          architecture: process.arch,
        })
        if (!next || cancelled) return
        if (hasVerbooFeedbackReceipt(next.campaignId)) {
          void finalizeVerbooFeedback(next.campaignId, next.deliveryId, 'skip')
          return
        }
        if (userActedRef.current || inputRef.current !== initialInput.current || submitCountRef.current !== initialSubmitCount.current) {
          void finalizeVerbooFeedback(next.campaignId, next.deliveryId, 'skip')
          return
        }
        setOffer(next)
        offerRef.current = next
        void markVerbooFeedbackViewed(next.deliveryId)
      } catch {
        // Feedback is optional. Startup and normal work continue silently.
      }
    })()
    return () => { cancelled = true }
  }, [eligibleAtMount, locale, modelId, provider])

  const skip = useCallback(() => {
    const current = offerRef.current
    if (!current || finalizingRef.current) return
    finalizingRef.current = true
    setOffer(null)
    offerRef.current = null
    void finalizeVerbooFeedback(current.campaignId, current.deliveryId, 'skip')
  }, [])

  const dismissForWork = useCallback(() => {
    userActedRef.current = true
    skip()
  }, [skip])

  const finishQuestion = useCallback((optionIds: string[]) => {
    const currentOffer = offerRef.current
    if (!currentOffer || finalizingRef.current) return
    const question = currentOffer.questions[questionIndex]
    if (!question) return
    const nextAnswers = [...answers, { questionId: question.id, optionIds }]
    if (questionIndex < currentOffer.questions.length - 1) {
      setAnswers(nextAnswers)
      setQuestionIndex(index => index + 1)
      setSelectedOptionIds(new Set())
      return
    }
    finalizingRef.current = true
    setOffer(null)
    offerRef.current = null
    setThanks(true)
    void finalizeVerbooFeedback(currentOffer.campaignId, currentOffer.deliveryId, 'response', nextAnswers)
  }, [answers, questionIndex])

  const handleDigit = useCallback((digit: string) => {
    const currentOffer = offerRef.current
    const question = currentOffer?.questions[questionIndex]
    if (!currentOffer || !question || finalizingRef.current) return
    if (digit === '0') {
      skip()
      return
    }
    const position = Number(digit)
    const option = question.options.find(item => item.position === position)
    if (!option) return
    if (question.type === 'single_choice') {
      finishQuestion([option.id])
      return
    }
    setSelectedOptionIds(current => {
      const next = new Set(current)
      if (next.has(option.id)) next.delete(option.id)
      else if (next.size < question.maxSelections) next.add(option.id)
      return next
    })
  }, [finishQuestion, questionIndex, skip])

  const question = offer?.questions[questionIndex]
  const validDigit = useCallback((input: string) => {
    if (!question || !/^\d$/.test(input)) return false
    if (input === '0') return true
    return question.options.some(option => option.position === Number(input))
  }, [question])

  useEffect(() => {
    if (submitCount === initialSubmitCount.current) return
    userActedRef.current = true
    if (offerRef.current) dismissForWork()
  }, [dismissForWork, submitCount])

  useEffect(() => {
    if (inputValue === initialInput.current || inputValue === '') return
    if (offerRef.current && validDigit(inputValue)) return
    userActedRef.current = true
    if (offerRef.current) dismissForWork()
  }, [dismissForWork, inputValue, validDigit])

  useEffect(() => {
    if (!thanks) return
    const timer = setTimeout(setThanks, 2_000, false)
    return () => clearTimeout(timer)
  }, [thanks])

  const handleSubmit = useCallback((input: string): boolean => {
    const currentOffer = offerRef.current
    const currentQuestion = currentOffer?.questions[questionIndex]
    if (!currentOffer || !currentQuestion) return false
    const trimmed = input.trim()
    if (validDigit(trimmed)) {
      setInputValue('')
      handleDigit(trimmed)
      return true
    }
    if (currentQuestion.type === 'multiple_choice' && trimmed === '') {
      if (selectedOptionIds.size >= currentQuestion.minSelections && selectedOptionIds.size <= currentQuestion.maxSelections) {
        finishQuestion([...selectedOptionIds])
        return true
      }
      // With no survey selection, Enter belongs to the normal prompt (for
      // example accepting a suggestion). An incomplete selection stays open.
      if (selectedOptionIds.size === 0) {
        dismissForWork()
        return false
      }
      return true
    }
    dismissForWork()
    return false
  }, [dismissForWork, finishQuestion, handleDigit, questionIndex, selectedOptionIds, setInputValue, validDigit])

  return useMemo(() => ({ offer, questionIndex, selectedOptionIds, thanks, handleDigit, handleSubmit, dismissForWork }), [dismissForWork, handleDigit, handleSubmit, offer, questionIndex, selectedOptionIds, thanks])
}
