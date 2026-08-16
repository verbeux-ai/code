import { describe, expect, test } from 'bun:test'

import { isStartupFeedbackEligible, type StartupFeedbackEligibility } from './useVerbooStartupFeedback.js'

const eligible: StartupFeedbackEligibility = {
  enabled: true,
  stdinTTY: true,
  stdoutTTY: true,
  entrypoint: 'cli',
  isRemoteSession: false,
  hasInitialPrompt: false,
  isBare: false,
  isCI: false,
  telemetryDisabled: false,
  policyAllowed: true,
  inheritedSurveyDisabled: false,
}

describe('startup feedback eligibility', () => {
  test('allows only a normal interactive CLI startup', () => {
    expect(isStartupFeedbackEligible(eligible)).toBe(true)
  })

  test.each([
    ['stdinTTY', false],
    ['stdoutTTY', false],
    ['entrypoint', 'sdk-cli'],
    ['isRemoteSession', true],
    ['hasInitialPrompt', true],
    ['isBare', true],
    ['isCI', true],
    ['telemetryDisabled', true],
    ['policyAllowed', false],
    ['inheritedSurveyDisabled', true],
  ] as const)('rejects %s=%s', (key, value) => {
    expect(isStartupFeedbackEligible({ ...eligible, [key]: value })).toBe(false)
  })
})
