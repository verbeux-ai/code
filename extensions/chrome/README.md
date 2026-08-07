# Verboo Code — Browser Control (Chrome Extension MV3)

Let Verboo control the browser: navigate, click, type, extract data, take screenshots, and automate web pages — all through your Verboo account session.

## Structure

```
extensions/verboo-chrome/
├── manifest.json          # MV3: contextMenus, identity, sidePanel, storage, alarms, notifications, scripting, tabs, tabGroups, activeTab, nativeMessaging, host_permissions, options_ui
├── package.json           # node --test runner
├── PRIVACY.md             # Privacy policy (Chrome Web Store)
├── PERMISSIONS.md         # Permission justifications (Chrome Web Store)
├── STORE_LISTING.md       # Store listing draft (name, tagline, description, screenshots)
├── _locales/
│   ├── en/messages.json   # Chrome i18n (manifest __MSG_*__ keys)
│   └── pt_BR/messages.json
├── icons/                 # 16/48/128 PNGs
└── src/
    ├── background.js      # Service worker — message router, agent turn loop
    ├── auth/
    │   ├── auth.js        # OAuth PKCE session, model catalog, and logout
    │   └── oauthConfig.js # Registered Chrome OAuth public-client configuration
    ├── controller/
    │   ├── protocol.js    # MSG enum, ToolCall/ToolResult/PolicyDecision contracts, makeToolCall, TOOL_RISK_MAP
    │   ├── execute.js     # execute(toolCall, ctx) — single chokepoint; runs evaluateToolPolicy before dispatch
    │   ├── execute.test.js
    │   ├── types.ts        # BrowserTool TS discriminated union (MVP: navigate, read_page, structured_extract, click, type, screenshot, tabs, tab_group)
    │   └── tools/
    │       ├── navigate.js         # chrome.tabs.update
    │       ├── readPage.js         # chrome.scripting.executeScript
    │       ├── structuredExtract.js # chrome.scripting.executeScript (schema-driven extraction)
    │       ├── click.js            # chrome.scripting.executeScript
    │       ├── type.js             # chrome.scripting.executeScript
    │       ├── screenshot.js       # chrome.tabs.captureVisibleTab (viewport-only; fullPage needs debugger, P3+)
    │       ├── tabs.js            # chrome.tabs list/switch/close/new
    │       ├── tabGroup.js        # chrome.tabGroups
    │       ├── consoleReader.js   # Read console logs from the active tab
    │       ├── networkReader.js   # Read network requests from the active tab
    │       ├── fileUpload.js     # Drive <input type="file"> for approved uploads
    │       └── gifRecording.js   # Record a short GIF of the viewport (opt-in)
    ├── panel/
    │   ├── panel.html     # Side panel UI (branding, auth, modes, grants, chat, tool approval)
    │   ├── panel.js       # Wires MSG.AGENT_TURN_START, renders thoughts/tool cards/results
    │   ├── panel.css      # Light + dark via prefers-color-scheme; risk badges (read=green, mutate=orange, elevated=red)
    │   ├── options.html   # Options page opened from chrome://extensions (manifest options_ui)
    │   ├── options.js     # Options page logic (session, mode, grants, diagnostics)
    │   └── optionsSession.js # Standalone-session helpers shared between panel and options
    ├── native/
    │   └── bridge.js      # Chrome Native Messaging client — connectNative to com.verboo.code.browser_extension with exponential reconnect (750ms → 30s, never stops trying)
    ├── routines/          # Local CRUD, slash commands, assets, recording, replay, schedules, and checkpoints
    ├── policy/
    │   ├── index.ts                  # checkPolicy facade (intent + URL + mode + grants)
    │   ├── evaluateToolPolicy.js      # Unified policy gate (hard blocks + mode + grant + elevated)
    │   ├── evaluateToolPolicy.test.js
    │   ├── hardBlocks.js              # Intent regex (purchase, trade, secret_exposure, mass deletion, create_account, prompt injection)
    │   ├── hardBlocks.test.js
    │   ├── policy.js                  # URL regex (chrome://, .gov.br, /login, /checkout)
    │   ├── policy.test.js
    │   ├── modesStore.js             # chromePermissionMode persistence (manual/auto/skip)
    │   ├── siteGrantsStore.js        # siteGrants persistence (per-host allow/deny)
    │   ├── siteGrantsStore.test.js
    │   └── types.ts                  # PolicyVerdict, SiteRule, PolicyConfig, ToolRestriction
    └── i18n/
        ├── en-US.js                  # JS i18n bundle (parity with desktop)
        └── pt-BR.js
```

## Permissions

### P1 + P2 (current manifest)

| Permission | Purpose |
|-----------|---------|
| `sidePanel` | Show the Verboo control panel in Chrome's side panel |
| `contextMenus` | Show Ask Verboo only for selected text and open the side panel with pending local context |
| `identity` | Open the user-initiated Verboo OAuth PKCE flow and receive its extension callback |
| `storage` | Persist Verboo session, permission mode, and per-site grants in `chrome.storage.local` |
| `alarms` | Wake locally scheduled routines in the user's selected timezone |
| `notifications` | Notify when a scheduled/resumed routine needs user attention |
| `scripting` | Inject code into pages for DOM extraction, clicks, and typing |
| `tabs` | Tab management (list, switch, close, navigate) |
| `tabGroups` | Group browser tabs by session |
| `activeTab` | Temporary access to the focused tab for `chrome.tabs.captureVisibleTab` (viewport screenshot fallback when `<all_urls>` is not the active grant) |
| `nativeMessaging` | Connect to the locally installed `com.verboo.code.browser_extension` host to relay tool requests from the Verboo CLI MCP server while the desktop app is closed |
| `http://*/*`, `https://*/*`, `<all_urls>` | Host access for scripting, tabs, and `captureVisibleTab` on any http(s) page (Chrome does not grant capture with plain `http(s)` patterns alone) |

### Future (not yet in manifest)

| Permission | Purpose | Phase |
|-----------|---------|-------|
| `debugger` | CDP-level access for full-page screenshots (`Page.captureScreenshot` with `captureBeyondViewport: true`) and sandboxed JavaScript evaluation (`Runtime.evaluate` in an isolated world) | P3+ |

See `PERMISSIONS.md` for the full justifications and `PRIVACY.md` for the privacy policy.

## Routines and Skills

Routines are scoped to the signed-in Verboo account and the current Chrome profile. A user can create or edit them in Settings, invoke them from the composer with `/`, save a prompt or conversation as an editable draft, attach approved text/image formats, or record a browser workflow. Recorded input values are unresolved by default and sensitive fields are discarded.

All browser actions still pass through the same policy executor. Replay checkpoints confirmed steps, falls back to one-step semantic recovery when a selector changes, and never rewrites the saved selector until the user accepts the suggestion. Optional daily, weekly, monthly, and annual schedules use `chrome.alarms`; they require explicit allowed origins and pause with a notification when authentication, variables, a compatible model, a normal window, or approval is missing.

## Auth model

The extension uses a **Verboo account session** (OAuth), not an API key. The session shape is:

```ts
interface VerbooSession {
  accountId: string
  email?: string
  accessToken: string
  refreshToken?: string
  expiresAt?: number   // ms since epoch
  source: 'oauth'
}
```

`startOAuthLogin()` uses `chrome.identity.launchWebAuthFlow` with Authorization Code + PKCE. The release configuration uses the registered public client `verboo-code-chrome-extension` and the published extension redirect `https://nkfgdaoblgcbngpklgnmjkfdabpbmpee.chromiumapp.org/oauth/callback`. The client id identifies the extension, not a person: every user signs in with their own Verboo account and receives their own tokens. It never falls back to a CLI credential or pasted key. The returned extension session is stored under `verbooSession`.

After OAuth is configured and the user starts a chat turn, the extension sends the user's prompt, selected active-page context, and browser-tool results to the Verboo Router. Page-derived values are explicitly fenced as untrusted data before they are returned to the model. The local MCP transport (`src/native/bridge.js`) connects to the `com.verboo.code.browser_extension` Native Messaging host installed by the desktop app and never carries a CLI token into the extension.

## Policy gate

Every tool call passes through `evaluateToolPolicy(mode, siteGrant, toolCall)` before any Chrome API is touched. The gate enforces:

1. **Hard blocks** (purchase, trade, secret exposure, mass deletion, create account, prompt injection obedience) — always block, even in Skip mode.
2. **Elevated tools** — always re-prompt, even in Auto/Skip and even with an `always` grant.
3. **Site grant `deny`** — always blocks.
4. **Site grant `always`** — allows without prompt.
5. **Site grant `once`** — allows this call only.
6. **No grant + Manual** — needs approval.
7. **No grant + Auto/Skip** — allowed (hard blocks already returned above).

The single chokepoint is `controller.execute(toolCall, ctx)`. Tool handlers are never called directly from `agent.js`, `background.js`, or the panel. See `src/controller/protocol.js` for the full invariant.

## Phases

- **P1** (committed `13d499e`): MV3 extension, folder structure, TypeScript contracts, auth session shell, policy engine, side panel shell.
- **P2** (committed `5bb13d2`): Browser Controller, agent turn loop, MVP tools (navigate, read_page, click, type, screenshot, tabs, tab_group), policy-gated execution.
- **P3** (committed): Store hardening — privacy policy, permission justifications, Store listing draft. Native Messaging bridge (`src/native/bridge.js`) connecting to the `com.verboo.code.browser_extension` host installed by the desktop app. Extended tool catalog (`structured_extract`, `console_reader`, `network_reader`, `file_upload`, `gif_recording`). Options page (`options_ui`).
- **P4** (future): Full catalog — error recovery, parallel tabs, advanced selectors, network interception, `debugger` permission for full-page screenshots.

## Development

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. "Load unpacked" → point to `extensions/verboo-chrome/`
4. Click the extension icon → "Open side panel"
5. Click "Sign in". OAuth is registered for the published Chrome Web Store id. An unpacked development install receives a different extension id and therefore needs its own redirect registration before its OAuth callback can succeed.

### Run tests

```bash
cd extensions/verboo-chrome
npm test
```

Tests use Node's built-in test runner (`node --test`). No extra dependencies.

## Português (Brasil)

Deixe o Verboo controlar o navegador: navegar, clicar, digitar, extrair dados, tirar screenshots e automatizar páginas — tudo pela sessão da sua conta Verboo. A árvore de arquivos comentada na seção **Structure** acima vale para os dois idiomas.

### Permissões (manifest atual)

`sidePanel` (painel de controle do Verboo no side panel do Chrome), `contextMenus` (**Perguntar ao Verboo** somente com texto selecionado, guardado localmente até o envio de um turno), `identity` (fluxo OAuth PKCE iniciado pelo usuário), `storage` (sessão, configurações, rotinas e checkpoints locais), `alarms` (agendamentos locais), `notifications` (avisos quando uma rotina precisa de atenção), `scripting` (injeção para extração de DOM, cliques e digitação), `tabs` (gerenciar abas), `tabGroups` (agrupar abas), `activeTab` (acesso temporário à aba focada para `captureVisibleTab`), `nativeMessaging` (conexão ao host local `com.verboo.code.browser_extension`) e host_permissions `http://*/*`, `https://*/*`, `<all_urls>` (acesso a hosts para scripting, tabs e capture). Futuro (fora do manifest): `debugger` para screenshots de página inteira e avaliação isolada de JavaScript (P4+). Veja `PERMISSIONS.md` para as justificativas completas e `PRIVACY.md` para a política de privacidade.

### Modelo de autenticação

A extensão usa **sessão de conta Verboo** (OAuth PKCE via `chrome.identity.launchWebAuthFlow`), nunca chave de API nem credencial do CLI. O public client `verboo-code-chrome-extension` está registrado para o redirect da extensão publicada; esse identificador é comum a todas as instalações, enquanto cada usuário entra na própria conta e recebe tokens próprios. Depois do OAuth, um turno iniciado pelo usuário envia prompt, contexto selecionado da página e resultados de ferramentas ao Verboo Router; valores derivados de página são cercados como dados não confiáveis antes de chegar ao modelo. O transporte MCP local (`src/native/bridge.js`) conecta ao host `com.verboo.code.browser_extension` instalado pelo app desktop e nunca leva token do CLI para a extensão.

### Portão de política

Toda chamada de ferramenta passa por `evaluateToolPolicy(mode, siteGrant, toolCall)` antes de qualquer API do Chrome: (1) bloqueios rígidos (compras, trades, exposição de segredos, deleção em massa, criação de conta, obediência a prompt injection) valem em todos os modos; (2) ferramentas elevadas sempre repedem confirmação; (3) `deny` por site sempre bloqueia; (4) `always` permite sem prompt; (5) `once` vale para uma chamada; (6) sem concessão + Manual exige aprovação; (7) sem concessão + Auto/Skip permite (os bloqueios rígidos já retornaram antes). O único ponto de entrada é `controller.execute(toolCall, ctx)`.

### Desenvolvimento

`chrome://extensions` → ativar "Developer mode" → "Load unpacked" apontando para `extensions/verboo-chrome/` → abrir o side panel pelo ícone. O OAuth de produção está registrado para o ID da Chrome Web Store; uma instalação unpacked ganha outro ID e precisa de um redirect próprio para concluir o login. Testes: `cd extensions/verboo-chrome && npm test` (runner nativo do Node, sem dependências extras).
