import React from 'react'
import { stringWidth } from '../ink/stringWidth.js'
import { Box, Text } from '../ink.js'
import type { NormalizedMessage } from '../types/message.js'
import { hasVisibleModelContent } from '../utils/routingModelHeaders.js'
type Props = {
  message: NormalizedMessage;
  isTranscriptMode: boolean;
  showRoutingModel?: boolean;
};
export function MessageModel({ message, isTranscriptMode, showRoutingModel = true }: Props) {
  if (!hasVisibleModelContent(message)) {
    return null
  }

  const requested = message.message.model
  const selected = message.message.metadata?.selected_model
  if (typeof selected === 'string' && !showRoutingModel) return null
  const display =
    typeof selected === 'string' && selected.length > 0
      ? `${requested} → ${selected}`
      : isTranscriptMode
        ? requested
        : null
  if (!display) return null

  return (
    <Box minWidth={stringWidth(display) + 8}>
      <Text dimColor>{display}</Text>
    </Box>
  )
}
