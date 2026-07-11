import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../services/analytics/index.js';
import { useAppState, useSetAppState } from '../../state/AppState.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { type EffortValue, getAvailableEffortLevels, getDisplayedEffortLevel, getEffortEnvOverride, getEffortValueDescription, isEffortLevel, isOpenAIEffortLevel, openAIEffortToStandard, toPersistableEffort } from '../../utils/effort.js';
import { EffortPicker } from '../../components/EffortPicker.js';
import { updateSettingsForSource } from '../../utils/settings/settings.js';
import { isVerbooMode } from '../../constants/oauth.js';
import { getVerbooReasoningEffort } from '../../services/api/verbooModels.js';
const COMMON_HELP_ARGS = ['help', '-h', '--help'];
type EffortCommandResult = {
  message: string;
  effortUpdate?: {
    value: EffortValue | undefined;
  };
};
function setEffortValue(effortValue: EffortValue): EffortCommandResult {
  const persistable = toPersistableEffort(effortValue);
  if (persistable !== undefined) {
    const result = updateSettingsForSource('userSettings', {
      effortLevel: persistable
    });
    if (result.error) {
      return {
        message: `Failed to set effort level: ${result.error.message}`
      };
    }
  }
  logEvent('tengu_effort_command', {
    effort: effortValue as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });

  // Env var wins at resolveAppliedEffort time. Only flag it when it actually
  // conflicts — if env matches what the user just asked for, the outcome is
  // the same, so "Set effort to X" is true and the note is noise.
  const envOverride = getEffortEnvOverride();
  if (envOverride !== undefined && envOverride !== effortValue) {
    const envRaw = process.env.CLAUDE_CODE_EFFORT_LEVEL;
    if (persistable === undefined) {
      return {
        message: `Not applied: CLAUDE_CODE_EFFORT_LEVEL=${envRaw} overrides effort this session, and ${effortValue} is session-only (nothing saved)`,
        effortUpdate: {
          value: effortValue
        }
      };
    }
    return {
      message: `CLAUDE_CODE_EFFORT_LEVEL=${envRaw} overrides this session — clear it and ${effortValue} takes over`,
      effortUpdate: {
        value: effortValue
      }
    };
  }
  const description = getEffortValueDescription(effortValue);
  const suffix = persistable !== undefined ? '' : ' (this session only)';
  return {
    message: `Set effort level to ${effortValue}${suffix}: ${description}`,
    effortUpdate: {
      value: effortValue
    }
  };
}
export function showCurrentEffort(appStateEffort: EffortValue | undefined, model: string): EffortCommandResult {
  const envOverride = getEffortEnvOverride();
  const effectiveValue = envOverride === null ? undefined : envOverride ?? appStateEffort;
  if (isVerbooMode()) {
    const displayed = getDisplayedEffortLevel(model, appStateEffort);
    const explicit = typeof effectiveValue === 'string' && Boolean(getVerbooReasoningEffort(model, effectiveValue));
    if (!explicit) {
      return {
        message: `Effort level: auto (currently ${displayed})`
      };
    }
    return {
      message: `Current effort level: ${displayed} (${getEffortValueDescription(displayed)})`
    };
  }
  if (effectiveValue === undefined) {
    const level = getDisplayedEffortLevel(model, appStateEffort);
    return {
      message: `Effort level: auto (currently ${level})`
    };
  }
  const description = getEffortValueDescription(effectiveValue);
  return {
    message: `Current effort level: ${effectiveValue} (${description})`
  };
}
function unsetEffortLevel(): EffortCommandResult {
  const result = updateSettingsForSource('userSettings', {
    effortLevel: undefined
  });
  if (result.error) {
    return {
      message: `Failed to set effort level: ${result.error.message}`
    };
  }
  logEvent('tengu_effort_command', {
    effort: 'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });
  // env=auto/unset (null) matches what /effort auto asks for, so only warn
  // when env is pinning a specific level that will keep overriding.
  const envOverride = getEffortEnvOverride();
  if (envOverride !== undefined && envOverride !== null) {
    const envRaw = process.env.CLAUDE_CODE_EFFORT_LEVEL;
    return {
      message: `Cleared effort from settings, but CLAUDE_CODE_EFFORT_LEVEL=${envRaw} still controls this session`,
      effortUpdate: {
        value: undefined
      }
    };
  }
  return {
    message: 'Effort level set to auto',
    effortUpdate: {
      value: undefined
    }
  };
}
export function executeEffort(args: string, model?: string): EffortCommandResult {
  const normalized = args.toLowerCase();
  if (normalized === 'auto' || normalized === 'unset') {
    return unsetEffortLevel();
  }
  if (isVerbooMode() && model) {
    const available = getAvailableEffortLevels(model);
    const supported = getVerbooReasoningEffort(model, normalized);
    if (supported) {
      return setEffortValue(supported);
    }
    return {
      message: available.length > 0
        ? `Invalid reasoning level: ${args}. Available for ${model}: ${available.join(', ')}, auto`
        : `Reasoning is not supported for ${model}`
    };
  }
  if (isEffortLevel(normalized)) {
    return setEffortValue(normalized);
  }
  if (isOpenAIEffortLevel(normalized)) {
    // Normalize OpenAI-shaped 'xhigh' → standard 'max' so it persists.
    return setEffortValue(openAIEffortToStandard(normalized));
  }
  return {
    message: `Invalid argument: ${args}. Valid options are: low, medium, high, max, xhigh, auto`
  };
}
function ShowCurrentEffort(t0) {
  const {
    onDone
  } = t0;
  const effortValue = useAppState(_temp);
  const model = useMainLoopModel();
  const {
    message
  } = showCurrentEffort(effortValue, model);
  onDone(message);
  return null;
}
function _temp(s) {
  return s.effortValue;
}
function ApplyEffortAndClose(t0) {
  const $ = _c(6);
  const {
    result,
    onDone
  } = t0;
  const setAppState = useSetAppState();
  const {
    effortUpdate,
    message
  } = result;
  let t1;
  let t2;
  if ($[0] !== effortUpdate || $[1] !== message || $[2] !== onDone || $[3] !== setAppState) {
    t1 = () => {
      if (effortUpdate) {
        setAppState(prev => ({
          ...prev,
          effortValue: effortUpdate.value
        }));
      }
      onDone(message);
    };
    t2 = [setAppState, effortUpdate, message, onDone];
    $[0] = effortUpdate;
    $[1] = message;
    $[2] = onDone;
    $[3] = setAppState;
    $[4] = t1;
    $[5] = t2;
  } else {
    t1 = $[4];
    t2 = $[5];
  }
  React.useEffect(t1, t2);
  return null;
}
function ExecuteEffort(t0) {
  const {
    args,
    onDone
  } = t0;
  const model = useMainLoopModel();
  return <ApplyEffortAndClose result={executeEffort(args, model)} onDone={onDone} />;
}
export async function call(onDone: LocalJSXCommandOnDone, _context: unknown, args?: string): Promise<React.ReactNode> {
  args = args?.trim() || '';
  if (COMMON_HELP_ARGS.includes(args)) {
    onDone('Usage: /effort [level|auto]\n\nThe available reasoning levels are loaded from /models for the active model.\n- auto: Use the model default returned by the API');
    return;
  }
  if (args === 'current' || args === 'status') {
    return <ShowCurrentEffort onDone={onDone} />;
  }
  if (!args) {
    return <EffortPickerWrapper onDone={onDone} />;
  }
  return <ExecuteEffort args={args} onDone={onDone} />;
}

function EffortPickerWrapper({ onDone }: { onDone: LocalJSXCommandOnDone }) {
  const setAppState = useSetAppState();
  const model = useMainLoopModel();

  function handleSelect(effort: EffortValue | undefined) {
    const persistable = toPersistableEffort(effort);
    if (persistable !== undefined) {
      updateSettingsForSource('userSettings', {
        effortLevel: persistable
      });
    }
    logEvent('tengu_effort_command', {
      effort: (effort ?? 'auto') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    setAppState(prev => ({
      ...prev,
      effortValue: effort
    }));
    const description = effort ? getEffortValueDescription(effort) : 'Use default effort level for your model';
    const suffix = persistable !== undefined ? '' : ' (this session only)';
    onDone(`Set effort level to ${effort ?? 'auto'}${suffix}: ${description}`);
  }

  function handleCancel() {
    onDone('Cancelled');
  }

  return <EffortPicker onSelect={handleSelect} onCancel={handleCancel} />;
}
