/**
 * gifRecord.js — record a short animated capture of the active tab.
 *
 * P5 SCAFFOLD. This is a stub that documents the contract for when
 * the `debugger` permission ships. Today, recording a GIF/animated
 * capture requires CDP `Page.startScreencast` (returns raw frames) +
 * an encoder (gifenc / gif.js / FFmpeg). The encoding library and
 * frame buffering are intentionally out of scope until the
 * `debugger` permission is added to the manifest.
 *
 * Risk: `elevated` (records every visible interaction, may capture
 * PII from the user's screen). evaluateToolPolicy forces
 * `needsApproval` in every mode — including Skip.
 *
 * What this stub does today:
 *   - Validates the params shape (durationMs, fps, format).
 *   - Returns a clear `unsupported_in_p5_scaffold` error with the
 *     upgrade path documented.
 *
 * @param {{
 *   name: 'gif_recording';
 *   durationMs?: number;
 *   fps?: number;
 *   format?: 'gif' | 'webp';
 *   risk?: string;
 *   input?: string;
 * }} tool
 * @returns {Promise<never>} throws — contract-only stub
 */
export async function gifRecording(tool) {
  const durationMs = clamp(tool?.durationMs, 100, 30_000, 3000)
  const fps = clamp(tool?.fps, 1, 30, 10)
  const format = tool?.format === 'webp' ? 'webp' : 'gif'

  // The contract is documented; the actual capture+encode lands
  // when the debugger permission is added (see PERMISSIONS.md).
  // We deliberately throw so the caller (controller.execute) wraps
  // the error in a ToolResult with success=false and the panel
  // surfaces it as an upgrade-required notification.
  throw new Error(
    `gif_record: unsupported_in_p5_scaffold — requires debugger + ` +
    `Page.startScreencast. Requested duration=${durationMs}ms fps=${fps} format=${format}.`,
  )
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
function clamp(value, min, max, fallback) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback
  return Math.max(min, Math.min(max, value))
}