import * as React from 'react'

import { getUserMessageText, textForResubmit } from '../utils/messages.js'
import type { Message, UserMessage } from '../types/message.js'
import { Select } from './CustomSelect/select.js'
import { Dialog } from './design-system/Dialog.js'
import { Box, Text } from '../ink.js'

const KEEP = '__keep_current_model__'
const MAX_MODELS = 5
// Text the CLI itself placed in a user message; the user did not type it.
const NOT_TYPED = /^\s*<(local-command-|bash-|task-notification)/

/** Verboo models to offer, the last Verboo model used first. */
export function limitSwitchModelOptions(
  models: ReadonlyArray<{ id: string; displayName?: string }>,
  lastRouterModel: string | undefined,
): Array<{ label: string; value: string }> {
  const ordered = [...models].sort((a, b) =>
    a.id === lastRouterModel ? -1 : b.id === lastRouterModel ? 1 : 0,
  )
  return [
    ...ordered.slice(0, MAX_MODELS).map(model => ({
      label: model.displayName ?? model.id,
      value: model.id,
    })),
    { label: 'Manter o modelo atual', value: KEEP },
  ]
}

export type FailedTurn = {
  /** The prompt that started the failed turn, when it can be sent again as is. */
  prompt: string | null
  promptUuid?: string
  /** Tools already ran in this turn: sending the prompt again would repeat them. */
  toolsRan: boolean
}

/** Looks back from the limit error to the message that started that turn. */
export function describeFailedTurn(messages: readonly Message[]): FailedTurn {
  let toolsRan = false
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.type === 'assistant') {
      const content = message.message.content
      if (Array.isArray(content) && content.some(block => block.type === 'tool_use')) {
        toolsRan = true
      }
      continue
    }
    if (
      message.type !== 'user' ||
      message.isMeta ||
      message.isCompactSummary ||
      message.isVisibleInTranscriptOnly
    ) {
      continue
    }
    const content = message.message.content
    if (Array.isArray(content) && content.some(block => block.type === 'tool_result')) {
      continue
    }
    // Images and other attachments cannot be sent again from the text alone.
    const hasOnlyText = !Array.isArray(content) || content.every(block => block.type === 'text')
    const resubmit = hasOnlyText ? textForResubmit(message as UserMessage) : null
    const text = resubmit?.mode === 'prompt' ? resubmit.text : ''
    return {
      prompt: text.trim() && !NOT_TYPED.test(getUserMessageText(message as UserMessage) ?? '') ? text : null,
      promptUuid: message.uuid,
      toolsRan,
    }
  }
  return { prompt: null, toolsRan }
}

export function limitSwitchDoneMessage(model: string, turn: FailedTurn): string {
  if (turn.toolsRan) {
    return `Modelo alterado para ${model}. A resposta anterior parou depois de executar ferramentas, então nada foi reenviado para não repetir ações. Diga como continuar.`
  }
  if (turn.prompt === null) {
    return `Modelo alterado para ${model}. Envie sua mensagem novamente para continuar.`
  }
  return `Modelo alterado para ${model}.`
}

type Props = {
  reason: string
  models: ReadonlyArray<{ id: string; displayName?: string }>
  lastRouterModel: string | undefined
  turn: FailedTurn
  onSwitch: (model: string) => void
  onKeep: () => void
}

/**
 * Opened by the REPL when the user's own account (ChatGPT plan, OpenAI or
 * Anthropic key) runs out; offers to continue on a Verboo model.
 */
export function LimitSwitchDialog({
  reason,
  models,
  lastRouterModel,
  turn,
  onSwitch,
  onKeep,
}: Props): React.ReactNode {
  const options = limitSwitchModelOptions(models, lastRouterModel)
  const consequence = turn.toolsRan
    ? ' Sua última mensagem não será reenviada, porque ela já executou ferramentas.'
    : turn.prompt !== null
      ? ' Sua última mensagem será reenviada.'
      : ''
  return (
    <Dialog title="Limite da sua conta atingido" color="warning" onCancel={onKeep}>
      <Box flexDirection="column" gap={1}>
        <Text>{reason.charAt(0).toUpperCase() + reason.slice(1)}</Text>
        <Text>Trocar para um modelo Verboo?{consequence}</Text>
        <Select
          defaultFocusValue={options[0]!.value}
          options={options}
          onChange={value => (value === KEEP ? onKeep() : onSwitch(value))}
          onCancel={onKeep}
        />
      </Box>
    </Dialog>
  )
}
