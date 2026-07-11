import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js'
import { logEvent } from '../../services/analytics/index.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isAnthropicAuthEnabled } from '../../utils/auth.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { isVoiceModeEnabled } from '../../voice/voiceModeEnabled.js'

export const call: LocalCommandCall = async () => {
  // Check auth and kill-switch before allowing voice mode
  if (!isVoiceModeEnabled()) {
    // Differentiate: OAuth-less users get an auth hint, everyone else
    // gets nothing (command shouldn't be reachable when the kill-switch is on).
    if (!isAnthropicAuthEnabled()) {
      return {
        type: 'text' as const,
        value:
          'Voice mode requires a Verboo account. Please run /login to sign in.',
      }
    }
    return {
      type: 'text' as const,
      value: 'Voice mode is not available.',
    }
  }

  const currentSettings = getInitialSettings()
  const isCurrentlyEnabled = currentSettings.voiceEnabled === true

  // Toggle OFF — no checks needed
  if (isCurrentlyEnabled) {
    const result = updateSettingsForSource('userSettings', {
      voiceEnabled: false,
    })
    if (result.error) {
      return {
        type: 'text' as const,
        value:
          'Failed to update settings. Check your settings file for syntax errors.',
      }
    }
    settingsChangeDetector.notifyChange('userSettings')
    logEvent('tengu_voice_toggled', { enabled: false })
    return {
      type: 'text' as const,
      value: 'Voice mode disabled.',
    }
  }

  // Toggle ON — run pre-flight checks first
  const { isVoiceStreamAvailable } = await import(
    '../../services/voiceStreamSTT.js'
  )
  const { checkRecordingAvailability } = await import('../../services/voice.js')

  // Check recording availability (microphone access)
  const recording = await checkRecordingAvailability()
  if (!recording.available) {
    return {
      type: 'text' as const,
      value:
        recording.reason ?? 'Voice mode is not available in this environment.',
    }
  }

  // Check for API key
  if (!isVoiceStreamAvailable()) {
    return {
      type: 'text' as const,
      value:
        'Voice mode requires a Verboo account. Please run /login to sign in.',
    }
  }

  // Check for recording tools
  const { checkVoiceDependencies, requestMicrophonePermission } = await import(
    '../../services/voice.js'
  )
  const deps = await checkVoiceDependencies()
  if (!deps.available) {
    const hint = deps.installCommand
      ? `\nInstall audio recording tools? Run: ${deps.installCommand}`
      : '\nInstall SoX manually for audio recording.'
    return {
      type: 'text' as const,
      value: `No audio recording tool found.${hint}`,
    }
  }

  // Probe mic access so the OS permission dialog fires now rather than
  // on the user's first hold-to-talk activation.
  if (!(await requestMicrophonePermission())) {
    let guidance: string
    if (process.platform === 'win32') {
      guidance = 'Settings \u2192 Privacy \u2192 Microphone'
    } else if (process.platform === 'linux') {
      guidance = "your system's audio settings"
    } else {
      guidance = 'System Settings \u2192 Privacy & Security \u2192 Microphone'
    }
    return {
      type: 'text' as const,
      value: `Microphone access is denied. To enable it, go to ${guidance}, then run /voice again.`,
    }
  }

  // All checks passed — enable voice
  const result = updateSettingsForSource('userSettings', { voiceEnabled: true })
  if (result.error) {
    return {
      type: 'text' as const,
      value:
        'Failed to update settings. Check your settings file for syntax errors.',
    }
  }
  settingsChangeDetector.notifyChange('userSettings')
  logEvent('tengu_voice_toggled', { enabled: true })
  const key = getShortcutDisplay('voice:pushToTalk', 'Chat', 'Space')
  return {
    type: 'text' as const,
    value: `Voice mode enabled. Hold ${key} to record.`,
  }
}
