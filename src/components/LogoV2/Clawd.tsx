// VERBOO-BRAND: Boo ghost mascot (replaces upstream "clawd" ASCII art).
// Pose API kept for backward-compat with call sites (WelcomeV2, LogoV2,
// CondensedLogo, AnimatedClawd) but visual is now a single ghost emoji.
import * as React from 'react'
import { Box, Text } from '../../ink.js'

export type ClawdPose = 'default' | 'arms-up' | 'look-left' | 'look-right'

type Props = {
  pose?: ClawdPose
}

export function Clawd(_props: Props = {}) {
  return (
    <Box flexDirection="column" alignItems="center">
      <Text color="claude">{'  '}</Text>
      <Text color="claude">{' 👻 '}</Text>
      <Text color="claude">{'  '}</Text>
    </Box>
  )
}
