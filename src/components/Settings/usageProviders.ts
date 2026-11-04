import { readCodexCredentialsAsync } from '../../utils/codexCredentials.js'

export type ConnectedUsageProviders = {
  codex: boolean
  claude: boolean
}

export async function getConnectedUsageProviders(): Promise<ConnectedUsageProviders> {
  const codexCredentials = await readCodexCredentialsAsync()
  return {
    codex: Boolean(codexCredentials),
    // Claude now connects with an API key, which has no usage windows to show.
    claude: false,
  }
}
