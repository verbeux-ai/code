# Human-session PTY harness

`startCli()` in `scripts/e2e/terminal.mjs` drives the installed CLI
(`.artifacts/package/consumer-path.txt`) in node-pty + headless xterm against
local fixtures. Everything below is optional; old tests keep working unchanged.

Run scenario files one at a time from the worktree root:

```sh
node --test --test-concurrency=1 scripts/e2e/human/<file>.e2e.mjs
```

The machine is shared: use 60 s waits (`waitForText` defaults to 60 s; the
older `waitFor` still defaults to 20 s).

## Isolation guarantees (always on)

- `HOME` = `<dir>/home`, `VERBOO_CONFIG_DIR` = `<dir>/config`,
  `VERBOO_PROJECTS_DIR` = `<dir>/projects`, `TMPDIR` = `<dir>/tmp`.
  `startCli` refuses a HOME or config dir inside the real profile, and refuses
  to unset `HOME`, `PATH`, `CLI_E2E_*`.
- A fake `secret-tool` (plus fake `xdg-open`/`open`) is always first on PATH.
  The real GNOME keyring is never read or written.
- In-process HTTP(S): `code.verboo.ai` goes to the fake router; `chatgpt.com`,
  `api.anthropic.com`, `api.openai.com` go to their fakes when enabled. Any
  other host is answered 503 and logged; `stop()` then throws.
- Subprocesses: `git` can only use `file://` (`GIT_ALLOW_PROTOCOL=file`), npm
  runs offline against `127.0.0.1:9`. Network-capable spawns (git
  clone/fetch/…, npm view/install/…, gh api/pr/…, curl, wget, ssh…) are logged
  to `subprocess-network.log` (tool, subcommand, origin+path only). Only git and
  npm are actually cut off: `gh`, `curl` and `wget` are logged but still run, so
  do not script a fake model into calling them against a real host.

## What the defaults hide

The harness sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_AUTOUPDATER`
and `DISABLE_TELEMETRY`. A real user has none of them, so a clean `networkLog()`
under the defaults says nothing about what a real session sends. To see that:

```js
import { REAL_USER_TRAFFIC_ENV, startCli } from '../terminal.mjs'
const cli = await startCli({ unsetEnv: REAL_USER_TRAFFIC_ENV, allowedNetwork: [/known-entry/] })
await cli.networkLog()   // everything that tried to leave, still blocked
```

With `anthropic: true` a request to an unknown path of `api.anthropic.com` lands
on the fake instead of the log, and fails `stop()` as `anthropic: GET /path`.
`allowedNetwork` matches that form too.

## Options

```js
import { startCli, KEYS } from '../terminal.mjs'

const cli = await startCli({
  columns: 120, rows: 40,
  model: 'fixture-model',            // null omits --model
  slashCommands: true,               // default false (--disable-slash-commands)
  skipPermissions: false,            // omit --dangerously-skip-permissions (default true)
  plugins: true,                     // do NOT set VERBOO_DISABLE_PLUGINS / ..._MARKETPLACE_AUTOINSTALL
  anthropic: true,                   // or createFakeAnthropic options, or a fake you created
  openai: true,                      // same for OpenAI
  routerOptions: { models: ['fixture-model', 'fixture-classifier'], agentModelRoles: { classifier: 'fixture-classifier' } },
  routerHandler: async (req, body, res) => { /* return true or write res to override */ },
  codexHandler: async (req, body, res) => { /* same, in front of codex-router.mjs */ },
  secureStorage: { openaiApiKey: openaiApiKeyCredential('sk-proj-…') },   // seeded into the fake keyring
  secureStorageError: true,          // every secret-tool call fails (exit 3) – vault unavailable
  plainTextCredentials: { … },       // written to <config>/.credentials.json (0600)
  userSettings: { permissions: { defaultMode: 'auto' } },                 // <config>/settings.json
  globalConfig: { … },               // merged into <config>/.config.json
  env: { VERBOO_AUTO_MODE_TIMEOUT_MS: '2000' },                           // extra/overriding env
  unsetEnv: ['VERBOO_PROJECTS_DIR'], // e.g. sessions then go to <config>/projects
  trusted: false,                    // primary project not trusted -> TrustDialog
  projectFiles: { '.verboo/settings.json': { hooks: {} } },               // objects are JSON-encoded
  extraProjects: { other: { files: { 'a.txt': 'x' }, trusted: false, git: true } },
  cwd: 'other',                      // extra project name, absolute path, or path relative to the project
  homeFiles: { '.claude/projects/-tmp-x/abc.jsonl': '…' },                // files under the temp HOME
  configFiles: { 'agents/x.md': '…' },                                    // files under the config dir
  reuse: previousCli,                // same dir (config, keyring, HOME, project) = user restarting
  failOnSubprocessNetwork: true,     // stop() also fails on subprocess-network.log entries
  allowedNetwork: [/^GET https:\/\/x\//], // matching entries do not fail stop(); they stay blocked and logged
  settingSources: 'user,project,local', // default 'user': project hooks/settings are IGNORED unless you add project; null omits the flag, as a real user runs
  strictMcp: false,                  // omit --strict-mcp-config --mcp-config, so a project .mcp.json is loaded as for a real user
  args: ['first prompt'],
})
```

Passed unless `strictMcp: false`: `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`, so a project
`.mcp.json` is not loaded. `CLAUDE_CODE_OAUTH_TOKEN=fixture-session` is the Verboo
session; `unsetEnv` it for the real logged-out flow, where the screen asks to
authenticate and `cli.browserOpens()` records the authorize URL.

`unsetEnv: ['VERBOO_CONFIG_DIR']` makes the config dir `<home>/.verboo` (the
real default layout, inside the temp HOME); the harness writes `.config.json`,
settings and credentials there and computes the keyring service name the same
way the CLI does.

## Driving the session

```js
await cli.waitForText('Describe a task')          // string (whitespace-insensitive) or RegExp; screen + new frames
await cli.submit('/openai login')                  // type, settle 250 ms, Enter
await cli.type('sk-proj-…', { delayMs: 20 })       // per-character typing
await cli.press('down', 2); await cli.press('enter') // names in KEYS (esc, tab, shift-tab, ctrl-c, …)
cli.screen(); cli.screenText(); cli.frames; cli.chunks; cli.raw
const { exitCode } = await cli.exit
await cli.stop()                                   // always, in finally
```

## Fake router (`code.verboo.ai`)

```js
import { hasToolResult, isClassifierRequest, lastUserText, sendChatCompletion, sendClassifierVerdict } from './http.mjs'

routerHandler: async (req, body, res) => {
  if (req.pathname !== '/router/v1/chat/completions') return       // default for /models, /api/me, …
  if (isClassifierRequest(body)) return sendClassifierVerdict(res, body, { shouldBlock: false, reason: 'safe' }).then(() => true)
  if (!body.tools?.length) return                                   // side queries keep the default
  return sendChatCompletion(res, body, { text: 'SCENARIO_REPLY' }).then(() => true)
}
```

Auto mode needs all of this (working example in `harness.e2e.mjs`):

```js
startCli({
  skipPermissions: false,
  userSettings: { skipAutoPermissionPrompt: true, permissions: { defaultMode: 'auto' } }, // the opt-in must be in user settings
  routerOptions: { models: ['fixture-model', 'fixture-classifier'], agentModelRoles: { classifier: 'fixture-classifier' } },
  routerHandler,
})
```

- A role whose model is not in `models` is ignored, and the classifier silently falls
  back to the main model. On the wire a role is a string; only the router's env var is a list.
- Have the fake model call an interpreter (`node -e …`), not `touch`: file edits in the
  project take the acceptEdits fast path and never reach the classifier.

`sendChatCompletion(res, request, { text, reasoning, toolCalls, finishReason, usage, model, headers, chunkSize, delayMs })`
streams SSE when `request.stream` is true, else returns JSON. Any endpoint
can be overridden (e.g. `req.pathname === '/router/v1/models'` to serve a
custom `agent_model_roles`). Inspect: `cli.router.requests` (chat bodies, as
before) and `cli.router.allRequests` (`{ method, path, query, headers, body }`
for every endpoint).

## Fake Anthropic (`api.anthropic.com`)

```js
import { anthropicErrors, createFakeAnthropic } from './fake-anthropic.mjs'

const cli = await startCli({ model: 'claude-sonnet-4-5-20250929', anthropic: { pageSize: 1 },
  secureStorage: { claudeNative: claudeApiKeyCredential('sk-ant-api03-…') } })
cli.anthropic.enqueue(anthropicErrors.creditBalanceTooLow())   // next POST /v1/messages
cli.anthropic.setResponder(record => record.body?.tools?.length ? { text: 'MAIN_REPLY' } : undefined)
cli.anthropic.messageRequests()[0].headers['x-api-key']
```

- `GET /v1/models` → `{ data, has_more, first_id, last_id }`, honours
  `limit`/`after_id` (`pageSize` forces pagination). Default models:
  `DEFAULT_ANTHROPIC_MODELS` (`claude-sonnet-4-5-20250929`, `claude-haiku-4-5-20251001`).
- `POST /v1/messages` → SSE (`message_start`, `ping`, `content_block_start/delta/stop`,
  `message_delta` with usage, `message_stop`) when `stream: true`, else a JSON message.
  `POST /v1/messages/count_tokens` → `{ input_tokens: 120 }`.
- Specs (from `enqueue`, or returned by `responder(record, res)`):
  `{ text }`, `{ content: [{ type: 'text'|'tool_use'|'thinking', … }], stopReason, usage, delayMs, delayBeforeMs }`,
  `{ status, json, headers }`, `{ handle: (res, record) => … }`; a responder may also write `res` itself and return `true`.
- Presets: `anthropicErrors.unauthorized()` (401), `.creditBalanceTooLow()` (400, real envelope; the message omits the provider name, so that word on screen can only come from the CLI),
  `.rateLimited(s)` (429 + retry-after), `.overloaded()` (529), `.permissionDenied()`, `.invalidRequest(msg)`.
- `requests` records everything: `{ index, at, method, path, query, headers, body, raw }`. Unknown paths → 404 + `unexpected` (fails `stop()`).

## Fake OpenAI (`api.openai.com`)

```js
import { createFakeOpenAI, openaiErrors } from './fake-openai.mjs'

const cli = await startCli({ model: 'openai-api/gpt-5.5', openai: true,
  secureStorage: { openaiApiKey: openaiApiKeyCredential('sk-proj-…') } })
cli.openai.enqueue(openaiErrors.insufficientQuota())            // next POST /v1/chat/completions
cli.openai.chatRequests()[0].body.model                         // 'gpt-5.5' (prefix stripped)
```

- `GET /v1/models` (default `gpt-5.5`, `gpt-5.5-mini` plus non-chat ids the CLI must filter),
  `POST /v1/chat/completions` (SSE + `[DONE]`, or JSON). Same spec/responder/enqueue model
  as Anthropic; chat specs are `sendChatCompletion` specs.
- Presets: `openaiErrors.insufficientQuota()` (429 insufficient_quota),
  `.rateLimitExceeded(s)` (429 rate_limit_exceeded + retry-after),
  `.invalidApiKey()` (401), `.serverError()` (500), `.modelNotFound(id)` (404).

To keep one fake across a restart, create it yourself and pass the instance
(`openai: myFake`); the harness then does not close it.

## Keyring and credentials

```js
import { claudeApiKeyCredential, claudeLegacyOAuthCredential, githubModelsCredential, openaiApiKeyCredential } from './keyring.mjs'

const cli = await startCli({ secureStorage: { claudeNative: claudeLegacyOAuthCredential() } })
await cli.readSecureStorage()   // decoded record for the CLI's service/account, or null
await cli.readKeyring()         // every entry: [{ attributes, label, raw, data }]
await cli.keyringOps()          // every secret-tool call: [{ action: 'lookup'|'store'|'clear', attributes }]
await cli.readPlainTextCredentials()   // <config>/.credentials.json or null
```

The keyring lives in `<dir>/keyring/` and survives `stop()` (read it after
the run) and `reuse`. With `codexOptions`/`codexHandler` the Codex fixture
credential is merged into the seeded record.

## Codex (`chatgpt.com`)

```js
const cli = await startCli({ model: 'gpt-5.5', routerOptions: {}, args: ['--effort', 'high', 'prompt'],
  codexHandler: async (req, body, res) => {
    if (req.pathname === '/backend-api/codex/responses' && body.text?.format?.type !== 'json_schema') {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', resets_in_seconds: 3600 } }))
      return true
    }
  } })
cli.codexProxy.requests   // every Codex request with headers and `handled`
```

Unhandled requests are forwarded (streamed) to `codex-router.mjs`, which
still flags prompts it has no scenario for as violations.

## Inspecting a run

- `cli.networkLog()` – blocked in-process requests (`METHOD origin/path`); non-empty fails `stop()`.
- `cli.subprocessNetworkLog()` – network-capable subprocesses (e.g. `npm view`, `gh pr`).
- `cli.browserOpens()` – URLs passed to the fake `xdg-open`/`open`.
- `cli.anthropic.requests`, `cli.openai.requests`, `cli.router.allRequests`, `cli.codexProxy.requests`.
- Artifacts in `cli.runDir` (`cli.dir` for the first run, `run-<n>/` for `reuse`):
  `screen.txt`, `frames.json`, `terminal.ansi`, `debug.log`, `requests.json`,
  `router-requests-all.json`, `anthropic-requests.json`, `openai-requests.json`,
  `codex-proxy-requests.json` (auth headers redacted to their last 4 chars),
  `unexpected-network.log`, `subprocess-network.log`, `startup-processes.jsonl`,
  `browser-opens.log`.

`harness.e2e.mjs` in this folder is a working example of each helper.
