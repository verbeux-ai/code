import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

import { isInGlobalClaudeFolder } from '../components/permissions/FilePermissionDialog/permissionOptions.tsx'
import { optionForPermissionSaveDestination } from '../components/permissions/rules/AddPermissionRules.tsx'
import {
  getClaudeSkillScope,
  isClaudeSettingsPath,
} from './permissions/filesystem.ts'
import { getValidationTip } from './settings/validationTips.ts'

const originalConfigDir = process.env.VERBOO_CONFIG_DIR

beforeEach(async () => {
  await acquireSharedMutationLock('openclaudeUiSurfaces.test.ts')
})

afterEach(() => {
  try {
    if (originalConfigDir === undefined) {
      delete process.env.VERBOO_CONFIG_DIR
    } else {
      process.env.VERBOO_CONFIG_DIR = originalConfigDir
    }
  } finally {
    releaseSharedMutationLock()
  }
})

describe('Verboo settings path surfaces', () => {
  test('isClaudeSettingsPath recognizes project .verboo settings files', () => {
    expect(
      isClaudeSettingsPath(
        join(process.cwd(), '.verboo', 'settings.json'),
      ),
    ).toBe(true)

    expect(
      isClaudeSettingsPath(
        join(process.cwd(), '.verboo', 'settings.local.json'),
      ),
    ).toBe(true)
  })

  test('permission save destinations point user settings to ~/.verboo', () => {
    expect(optionForPermissionSaveDestination('userSettings')).toEqual({
      label: 'User settings',
      description: 'Saved in ~/.verboo/settings.json',
      value: 'userSettings',
    })
  })

  test('permission save destinations point project settings to .verboo', () => {
    expect(optionForPermissionSaveDestination('projectSettings')).toEqual({
      label: 'Project settings',
      description: 'Checked in at .verboo/settings.json',
      value: 'projectSettings',
    })

    expect(optionForPermissionSaveDestination('localSettings')).toEqual({
      label: 'Project settings (local)',
      description: 'Saved in .verboo/settings.local.json',
      value: 'localSettings',
    })
  })

  test('permission dialog treats ~/.verboo as the global Claude folder', () => {
    process.env.VERBOO_CONFIG_DIR = join(homedir(), '.verboo')

    expect(
      isInGlobalClaudeFolder(
        join(homedir(), '.verboo', 'settings.json'),
      ),
    ).toBe(true)
    expect(
      isInGlobalClaudeFolder(join(homedir(), '.claude', 'settings.json')),
    ).toBe(true)
  })

  test('permission dialog does not treat arbitrary VERBOO_CONFIG_DIR as the global Claude folder', () => {
    process.env.VERBOO_CONFIG_DIR = join(homedir(), 'custom-verboo')

    expect(
      isInGlobalClaudeFolder(
        join(homedir(), 'custom-verboo', 'settings.json'),
      ),
    ).toBe(false)
  })

  test('global skill scope recognizes ~/.verboo and legacy ~/.claude skills', () => {
    process.env.VERBOO_CONFIG_DIR = join(homedir(), '.verboo')

    expect(
      getClaudeSkillScope(
        join(homedir(), '.verboo', 'skills', 'demo', 'SKILL.md'),
      ),
    ).toEqual({
      skillName: 'demo',
      pattern: '~/.verboo/skills/demo/**',
    })

    expect(
      getClaudeSkillScope(
        join(homedir(), '.claude', 'skills', 'legacy', 'SKILL.md'),
      ),
    ).toEqual({
      skillName: 'legacy',
      pattern: '~/.claude/skills/legacy/**',
    })
  })

  test('global skill scope does not emit fixed rules for arbitrary VERBOO_CONFIG_DIR skills', () => {
    process.env.VERBOO_CONFIG_DIR = join(homedir(), 'custom-verboo')

    expect(
      getClaudeSkillScope(
        join(homedir(), 'custom-verboo', 'skills', 'demo', 'SKILL.md'),
      ),
    ).toBe(null)
  })
})

describe('Verboo Code validation tips', () => {
  test('permissions.defaultMode invalid value keeps suggestion but no Claude docs link', () => {
    const tip = getValidationTip({
      path: 'permissions.defaultMode',
      code: 'invalid_value',
      enumValues: [
        'acceptEdits',
        'bypassPermissions',
        'default',
        'dontAsk',
        'plan',
      ],
    })

    expect(tip).toEqual({
      suggestion:
        'Valid modes: "acceptEdits" (ask before file changes), "plan" (analysis only), "bypassPermissions" (auto-accept all), or "default" (standard behavior)',
    })
  })
})
