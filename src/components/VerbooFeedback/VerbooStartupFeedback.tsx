import React, { useCallback } from 'react'

import { Box, Text } from '../../ink.js'
import { useDebouncedDigitInput } from '../FeedbackSurvey/useDebouncedDigitInput.js'
import type { VerbooStartupFeedbackState } from './useVerbooStartupFeedback.js'

type Props = Pick<VerbooStartupFeedbackState, 'offer' | 'questionIndex' | 'selectedOptionIds' | 'thanks' | 'handleDigit'> & {
  inputValue: string
  setInputValue: (value: string) => void
  locale: 'pt' | 'en'
}

export function VerbooStartupFeedback({ offer, questionIndex, selectedOptionIds, thanks, handleDigit, inputValue, setInputValue, locale }: Props) {
  const question = offer?.questions[questionIndex]
  const copy = locale === 'en'
    ? {
      thanks: 'Thanks for your feedback!',
      skip: 'Skip',
      multiple: (min: number, max: number) => `Choose ${min} to ${max} options and press Enter to confirm. `,
      optional: 'Optional · start typing normally to continue your work.',
    }
    : {
      thanks: 'Obrigado pelo feedback!',
      skip: 'Pular',
      multiple: (min: number, max: number) => `Escolha de ${min} a ${max} opções e pressione Enter para confirmar. `,
      optional: 'Opcional · comece a digitar normalmente para continuar o trabalho.',
    }
  const isValidDigit = useCallback((digit: string): digit is string => {
    if (!question || !/^\d$/.test(digit)) return false
    return digit === '0' || question.options.some(option => option.position === Number(digit))
  }, [question])

  useDebouncedDigitInput({ inputValue, setInputValue, isValidDigit, onDigit: handleDigit, enabled: Boolean(question) })

  if (thanks) return <Box marginTop={1}><Text color="success">✓ {copy.thanks}</Text></Box>
  if (!offer || !question) return null

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box><Text color="ansi:cyan">● </Text><Text bold>{offer.title}</Text></Box>
      {offer.intro ? <Text dimColor>{offer.intro}</Text> : null}
      <Box marginTop={1}><Text>{question.text} <Text dimColor>({questionIndex + 1}/{offer.questions.length})</Text></Text></Box>
      <Box flexDirection="column" marginLeft={2}>
        {question.options.map(option => {
          const selected = selectedOptionIds.has(option.id)
          return <Text key={option.id}><Text color="ansi:cyan">[{option.position}]</Text> {question.type === 'multiple_choice' ? <Text color={selected ? 'success' : undefined}>{selected ? '◉' : '○'} </Text> : null}{option.label}</Text>
        })}
        <Text><Text color="ansi:cyan">[0]</Text> {copy.skip}</Text>
      </Box>
      <Text dimColor>{question.type === 'multiple_choice' ? copy.multiple(question.minSelections, question.maxSelections) : ''}{copy.optional}</Text>
    </Box>
  )
}
