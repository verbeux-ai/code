# vision-fallback (built-in plugin)

Built-in Verboo Code plugin that gives text-only models the ability to process images.

When a user submits a prompt with image attachments, the `UserPromptSubmit` hook sends the images to a vision-capable model (`ultra/qwen3.6-27b` by default, with `ultra/kimi-k2.7` as fallback) and injects the resulting description into the main model's context via `additionalContext`.

## Behavior

- No-op when the prompt has no image attachments.
- Uses `ultra/qwen3.6-27b` as the primary vision model.
- Falls back to `ultra/kimi-k2.7` if the primary model fails or times out.
- Fails open: if all vision models fail, a short warning is injected and the main model continues.

## Configuration

Environment variables (all optional):

| Variable | Default | Description |
|---|---|---|
| `VERBOO_VISION_PRIMARY_MODEL` | `ultra/qwen3.6-27b` | Primary vision model |
| `VERBOO_VISION_FALLBACK_MODEL` | `ultra/kimi-k2.7` | Fallback vision model |
| `VERBOO_VISION_BASE_URL` | `https://code.verboo.ai/router/v1` | OpenAI-compatible router endpoint |
| `VISION_API_KEY` | resolved from `opencode.json` | Router API key |

## Files

- `index.ts` — plugin registration
- `runtime.ts` — hook command that calls the vision models
- `__tests__/visionFallback.test.ts` — unit tests
