import type React from 'react'
import { Box, Text } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import { getGlobalConfig } from '../../utils/config.js'
import {
  VERBOO_IN_CHROME_MCP_SERVER_NAME,
  isManagedVerbooInChromeConfig,
  isVerbooInChromeMcpServer,
} from '../../utils/verbooInChrome.js'
import { Dialog } from '../../components/design-system/Dialog.js'

type Props = {
  onDone: (result?: string) => void
}

function VerbooInChromeMenu({ onDone }: Props): React.ReactNode {
  const mcpClients = useAppState(state => state.mcp.clients)
  const chromeClient = mcpClients.find(client =>
    isVerbooInChromeMcpServer(client.name),
  )
  const configured = isManagedVerbooInChromeConfig(
    getGlobalConfig().mcpServers?.[VERBOO_IN_CHROME_MCP_SERVER_NAME],
  )
  const connected = chromeClient?.type === 'connected'

  return (
    <Dialog title="Verboo in Chrome" onCancel={() => onDone()} color="chromeYellow">
      <Box flexDirection="column" gap={1}>
        <Text>
          Verboo Code uses the local MCP installed by the Verboo desktop app.
          Browser actions remain protected by the extension's site permissions
          and approval flow.
        </Text>
        <Box flexDirection="column">
          <Text>
            MCP setup:{' '}
            {configured ? (
              <Text color="success">Installed</Text>
            ) : (
              <Text color="warning">Not installed</Text>
            )}
          </Text>
          <Text>
            Connection:{' '}
            {connected ? (
              <Text color="success">Connected</Text>
            ) : (
              <Text color="inactive">Disconnected</Text>
            )}
          </Text>
        </Box>
        {!configured && (
          <Text color="warning">
            Open Verboo desktop &gt; Settings &gt; Integrations &gt; Chrome, then install
            or repair the integration.
          </Text>
        )}
        {configured && !connected && (
          <Text color="warning">
            Open Chrome and the Verboo extension, then run /mcp to reconnect.
          </Text>
        )}
        <Text dimColor>
          Per session: verboo --chrome or verboo --no-chrome. Press Esc to close.
        </Text>
      </Box>
    </Dialog>
  )
}

export const call = async function (
  onDone: (result?: string) => void,
): Promise<React.ReactNode> {
  return <VerbooInChromeMenu onDone={onDone} />
}
