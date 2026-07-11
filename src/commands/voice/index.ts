import type { Command } from '../../commands.js'
import { isVoiceGrowthBookEnabled } from '../../voice/voiceModeEnabled.js'

const voice = {
  type: 'local',
  name: 'voice',
  description: 'Toggle voice mode',
  isEnabled: () => isVoiceGrowthBookEnabled(),
  get isHidden() {
    // Keep the command discoverable before login. Invoking it explains that
    // a Verboo account is required, while the router enforces auth again.
    return !isVoiceGrowthBookEnabled()
  },
  supportsNonInteractive: false,
  load: () => import('./voice.js'),
} satisfies Command

export default voice
