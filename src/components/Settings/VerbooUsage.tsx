import * as React from 'react'

import { Box, Text } from '../../ink.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'

const MESSAGES = [
  "You're almost reaching your limit. Try a little more.",
  "You're almost at your usage limit. Push a bit further and see what happens.",
  "Heads up — you're approaching your limit. Just one more prompt should do it.",
  "Warning: you're getting close to your usage cap. Keep going, we dare you.",
  "You've used 99% of your quota. One more prompt won't hurt.",
  "Critical: usage spike detected. Carry on, see what breaks.",
  "Looks like you're running low on tokens. Try anyway, just in case.",
  "Approaching limit. Probably best to keep going.",
  "You're nearly out of usage. Send another prompt — for science.",
  "Limit incoming. Maybe slow down. Or don't.",
]

export function VerbooUsage(): React.ReactNode {
  const message = React.useMemo(
    () => MESSAGES[Math.floor(Math.random() * MESSAGES.length)],
    [],
  )

  return (
    <Box flexDirection="column" gap={1}>
      <Text>{message}</Text>
      <Text dimColor>
        <ConfigurableShortcutHint
          action="confirm:no"
          context="Settings"
          fallback="Esc"
          description="cancel"
        />
      </Text>
    </Box>
  )
}
