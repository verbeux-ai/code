# Hooks

Verboo Code supports lifecycle hooks that run shell commands, LLM prompts, HTTP requests, or agentic verifiers at specific points during a session.

## Configuration

Hooks are configured in `~/.verboo/settings.json` under the `hooks` key:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'user submitted a prompt'",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

## Events

See `src/entrypoints/sdk/coreTypes.ts` for the full list of hook events.

## `UserPromptSubmit` input

The `UserPromptSubmit` hook receives the following input as JSON on stdin:

```ts
{
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
  hook_event_name: 'UserPromptSubmit'
  prompt: string
  attachments?: Array<{
    type: 'image'
    source: 'base64' | 'file'
    mediaType: string
    data?: string      // base64 data when source is 'base64'
    path?: string      // absolute file path when source is 'file'
    filename?: string
  }>
}
```

### Image attachments

When the user submits a prompt with image attachments (paste, drag-and-drop, or bridge), the `attachments` field is populated with metadata for each image. Hooks can use this data to call vision models, resize images, or extract text before the main model sees the prompt.

`attachments` is only present when the prompt includes at least one image. Hooks that do not need image data can ignore the field safely.

### Example: vision fallback hook

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.verboo/plugins/vision-fallback/runtime.js",
            "timeout": 60
          }
        ]
      }
    ]
  }
}
```

The command receives the hook input JSON on stdin and should print a JSON object to stdout. To inject context before the main model responds, use:

```json
{
  "hookSpecificOutput": {
    "additionalContext": "Description of the attached image."
  }
}
```

## Output format

Hook commands should print a single JSON object to stdout. Common fields:

| Field | Description |
|---|---|
| `hookSpecificOutput.additionalContext` | Injected into the model context (UserPromptSubmit only) |
| `systemMessage` | Shown to the user as a system message |
| `blockingError` | Blocks the operation and shows an error |
| `preventContinuation` | Stops processing but keeps the prompt in context |

## Built-in plugins with hooks

Some bundled plugins register hooks automatically:

- `vision-fallback` — describes image attachments for text-only models using `ultra/qwen3.6-27b` and `ultra/kimi-k2.7`.
