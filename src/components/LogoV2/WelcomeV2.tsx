import * as React from 'react'
import { Box, Text } from 'src/ink.js'

export function WelcomeV2(): React.ReactElement {
  const version = MACRO.DISPLAY_VERSION ?? MACRO.VERSION

  return (
    <Box flexDirection="column" marginY={1} paddingX={1}>
      <Box flexDirection="row" gap={1} alignItems="center">
        <Text>👻</Text>
        <Text bold color="claude">
          Verboo Code
        </Text>
        <Text dimColor>v{version}</Text>
      </Box>
      <Box paddingLeft={3}>
        <Text dimColor>Build, debug, and ship from your terminal.</Text>
      </Box>
    </Box>
  )
}
