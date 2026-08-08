import * as React from 'react'
import { Box, Text } from 'src/ink.js'

const VERBOO_LOGO = [
  '  ▄▀▀▀▀▀▀▀▄  ',
  '▄▀▀▀▀▀▀▀▀▀▀▀▄',
  '▀▀▀ ▀▀▀▀▀ ▀▀▀',
  '▀▀▀▀▀▀▀▀▀▀▀▀▀',
  '▀▀▀▀▀▄▄▄▀▀▀▀▀',
  ' ▀▀▀▀▀▀▀▀▀▀▀ ',
  '▄▀▀ ▀▀▀▀▀ ▀▀▄',
]

export function WelcomeV2(): React.ReactElement {
  const version = MACRO.DISPLAY_VERSION ?? MACRO.VERSION

  return (
    <Box flexDirection="row" gap={2} marginY={1} paddingX={1} alignItems="center">
      <Box flexDirection="column">
        {VERBOO_LOGO.map((line, index) => (
          <Text color="claude" key={index}>
            {line}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold color="claude">
            Verboo Code
          </Text>
          <Text dimColor>v{version}</Text>
        </Box>
        <Text dimColor>Build, debug, and ship from your terminal.</Text>
      </Box>
    </Box>
  )
}
