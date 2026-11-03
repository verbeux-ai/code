import * as React from 'react'

import { Select } from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Box, Text } from '../../ink.js'
import { getCachedVerbooModels } from '../../services/api/verbooModels.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import type { Message, UserMessage } from '../../types/message.js'
import { getGlobalConfig } from '../../utils/config.js'
import { textForResubmit } from '../../utils/messages.js'
import { saveLastVerbooModel } from '../../utils/model/model.js'

const KEEP = '__keep_current_model__'
const MAX_MODELS = 5

/** Verboo models to offer, the last Verboo model used first. */
export function limitSwitchModelOptions(
  models: ReadonlyArray<{ id: string; displayName?: string }>,
  lastVerbooModel: string | undefined,
): Array<{ label: string; value: string }> {
  const ordered = [...models].sort((a, b) =>
    a.id === lastVerbooModel ? -1 : b.id === lastVerbooModel ? 1 : 0,
  )
  return [
    ...ordered.slice(0, MAX_MODELS).map(model => ({
      label: model.displayName ?? model.id,
      value: model.id,
    })),
    { label: 'Manter o modelo atual', value: KEEP },
  ]
}

/** Text of the last prompt the user typed, to send again on the new model. */
export function lastUserPromptText(messages: readonly Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.type !== 'user' || message.isMeta) continue
    const resubmit = textForResubmit(message as UserMessage)
    if (resubmit?.mode === 'prompt' && resubmit.text.trim()) return resubmit.text
  }
  return null
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const models = getCachedVerbooModels() ?? []
  if (models.length === 0) {
    onDone('Nenhum modelo Verboo disponível na sua conta. Use /model para ver as opções.', {
      display: 'system',
    })
    return
  }
  const reason = args.trim() || 'o limite da sua conta acabou.'
  const options = limitSwitchModelOptions(models, getGlobalConfig().lastVerbooModel)
  const prompt = lastUserPromptText(context.messages)
  const keep = () =>
    onDone('Modelo mantido. Use /model quando quiser trocar.', { display: 'system' })

  return (
    <Dialog title="Limite da sua conta atingido" color="warning" onCancel={keep}>
      <Box flexDirection="column" gap={1}>
        <Text>{reason.charAt(0).toUpperCase() + reason.slice(1)}</Text>
        <Text>Trocar para um modelo Verboo?{prompt ? ' Sua última mensagem será reenviada.' : ''}</Text>
        <Select
          defaultFocusValue={options[0]!.value}
          options={options}
          onChange={value => {
            if (value === KEEP) {
              keep()
              return
            }
            saveLastVerbooModel(value)
            context.setAppState(prev => ({
              ...prev,
              mainLoopModel: value,
              mainLoopModelForSession: null,
            }))
            onDone(`Modelo alterado para ${value}.`, {
              display: 'system',
              ...(prompt ? { nextInput: prompt, submitNextInput: true } : {}),
            })
          }}
          onCancel={keep}
        />
      </Box>
    </Dialog>
  )
}
