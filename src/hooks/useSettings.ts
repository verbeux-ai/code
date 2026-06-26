import React from 'react'
import {
  type AppState,
  useAppStateMaybeOutsideOfProvider,
} from '../state/AppState.js'
import { getInitialSettings } from '../utils/settings/settings.js'

/**
 * Settings type as stored in AppState (DeepImmutable wrapped).
 * Use this type when you need to annotate variables that hold settings from useSettings().
 */
export type ReadonlySettings = AppState['settings']

/**
 * React hook to access current settings from AppState.
 * Settings automatically update when files change on disk via settingsChangeDetector.
 *
 * Use this instead of getSettings_DEPRECATED() in React components for reactive updates.
 */
export function useSettings(): ReadonlySettings {
  const settings = useAppStateMaybeOutsideOfProvider(s => s.settings)
  const fallbackSettingsRef = React.useRef<ReadonlySettings | null>(null)

  if (settings) {
    return settings
  }

  fallbackSettingsRef.current ??= getInitialSettings()
  return fallbackSettingsRef.current
}
