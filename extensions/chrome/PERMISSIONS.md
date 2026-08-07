# Permissions Justifications — Chrome Web Store

This document is the source of truth for the permission justifications shown on the Chrome Web Store listing. Each justification explains **what** the permission does, **why** we need it, and **what is NOT done** with it, so reviewers and users can audit the extension's footprint.

When adding or removing a permission, update this file in the same PR.

---

## `sidePanel`

**What it is.** Allows the extension to render UI in Chrome's side panel area.

**Why we need it.** Verboo's primary surface is the side panel — that is where the chat, tool-approval prompts, permission mode selector, and site grants live. Without `sidePanel`, the extension cannot show its main interface.

**What we don't do with it.** We do not inject content into the side panel of unrelated extensions. We do not replace Chrome's native UI. The side panel appears only when you click the Verboo toolbar icon or choose **Ask Verboo** after selecting text.

---

## `contextMenus`

**What it is.** Lets the extension add one item to Chrome's right-click menu.

**Why we need it.** The item is **Ask Verboo** and appears only when text is selected. Choosing it opens the Verboo side panel for that tab and captures the selected text as pending context.

**What we don't do with it.** We do not add page, image, media, or browser-history menu entries; the one item always requires a text selection. Choosing it does not transmit text; the selected text remains in `chrome.storage.session` until the user sends a chat turn, or dismisses it. The text is fenced as untrusted browser content before model processing.

---

## `identity`

**What it is.** Lets Chrome open and complete a user-initiated OAuth flow for the extension.

**Why we need it.** Standalone chat authenticates with a Verboo account using Authorization Code + PKCE. Chrome supplies an extension-specific callback URL and returns that callback only to this extension.

**What we don't do with it.** We do not reuse CLI credentials, silently start sign-in, or request a token unless the user clicks **Sign in**. If the registered Chrome OAuth client ID is absent, authentication fails closed.

---

## `storage`

**What it is.** Lets the extension persist data in `chrome.storage.local`.

**Why we need it.** We store these keys in `chrome.storage.local`:

1. `verbooSession` — your Verboo **session token** (so you do not have to sign in every time Chrome restarts).
2. `chromePermissionMode` — your **permission mode** (Manual / Auto / Skip — your chosen safety level).
3. `siteGrants` — your **per-site grants** (which hosts you have approved or denied).
4. `verbooModelsCache` — the model catalog returned by the Verboo Router.
5. `verbooSelectedModelId` — the model selected in the side panel.
6. `verbooRoutinesV1` — account-scoped saved routines, variable defaults, schedules, and recorded steps.
7. `verbooRoutineRunsV1` — bounded run status/history and restart-safe checkpoints.

`verbooSelectionContexts` is temporary `chrome.storage.session` state, not persistent local storage. It holds selected-text context only until the user dismisses it or the first chat turn consumes it.

**What we don't do with it.**

- We do not store your browsing history.
- We discard password, payment, token, and other sensitive recording fields.
- Routine instructions, explicit variable defaults, and files selected by the user are stored only for that routine in this Chrome profile.
- We do not sync storage to your Google account.
- The OAuth access token is sent only to the Verboo Router endpoints bundled with the extension.

---

## `alarms`

**What it is.** Lets Chrome wake the service worker at a locally stored routine time.

**Why we need it.** Users can opt into daily, weekly, monthly, or annual execution. Calendar recurrence is calculated in the selected IANA timezone, and a missed occurrence runs at most once when Chrome becomes available.

**What we don't do with it.** We do not create schedules without an explicit saved routine, run multiple catch-up copies, or send a schedule to a remote scheduling service.

---

## `notifications`

**What it is.** Shows a Chrome notification from the extension.

**Why we need it.** A scheduled or resumed routine may need the user to sign in, approve a site, provide a variable, select a compatible model, or open a normal browser window. The notification brings the user back to Verboo without bypassing the policy gate.

**What we don't do with it.** We do not send marketing notifications or use notifications for tracking.

---

## `activeTab`

**What it is.** Grants the extension temporary access to the focused tab when you invoke the extension (clicking the toolbar icon, opening the side panel, or running a context-menu item). Unlike `host_permissions`, `activeTab` is per-gesture and expires when the tab navigates or you stop interacting.

**Why we need it.** `chrome.tabs.captureVisibleTab` requires either `<all_urls>` host permission or temporary `activeTab` to take a viewport screenshot from the side panel. We declare both so capture keeps working if a future Store review forces us to drop `<all_urls>`. The screenshot tool (`src/controller/tools/screenshot.js`) is the only consumer; it calls `chrome.tabs.captureVisibleTab` for the focused tab's viewport.

**What we don't do with it.** We do not use `activeTab` to read browsing history, persist access after the turn ends, or attach to tabs the user did not gesture toward. Internal Chrome pages (`chrome://`, `chrome-extension://`, `about:`) are rejected by the planner (`src/planMessage.js:isControllableUrl`) before any tool runs, so `activeTab` never grants access to them.

---

## `nativeMessaging`

**What it is.** Lets the extension connect to the locally installed `com.verboo.code.browser_extension` host over Chrome's framed stdin/stdout protocol.

**Why we need it.** The official `verboo-in-chrome` MCP server uses this host to relay browser-only tool requests from Verboo CLI to the extension while the desktop app is closed.

**What we don't do with it.**

- We do not send CLI credentials, extension OAuth tokens, filesystem data, terminal commands, or Git operations through the host.
- The host cannot call Chrome APIs directly; every request still passes through the extension's canonical policy and approval executor.
- A request that needs approval fails closed when the Verboo side panel is unavailable.
- An in-flight request is never replayed after a native-port disconnect.

---

## `scripting`

**What it is.** Allows the extension to inject scripts into web pages you visit.

**Why we need it.** Several tools require running code in the page context:

- `read_page` — reads the DOM to extract what you see.
- `click` — dispatches a mouse click on an element you chose.
- `type` — fills a form field with text you provided.
- `screenshot` — measures viewport size before capturing the tab.
- `Ask Verboo` selected-text context — reads `window.getSelection()` after the user chooses the text-selection context-menu item.

Browser tools are gated by the policy engine: tools execute only after `evaluateToolPolicy` allows the call, and in Manual mode only after you click **Approve**. The selected-text read is a narrow exception: it follows an explicit context-menu gesture, cannot mutate the page, is not initiated by the model, and its result stays local until the user sends a chat turn.

**What we don't do with it.**

- We do not inject scripts on `chrome://`, `chrome-extension://`, or `about:` pages — these are hard-blocked.
- We do not run code fetched from a remote origin. The injected functions are bundled in the extension.
- Page content is sent only to the Verboo Router during a chat turn the user started, and is fenced as untrusted browser data before model processing.

---

## `tabs`

**What it is.** Lets the extension read and manipulate Chrome tabs.

**Why we need it.** The `tabs` tool requires `tabs` permission to:

- List the open tabs (so the agent can show what is running).
- Switch to a tab by ID.
- Close a tab (when you ask it to).
- Open a new tab to a URL you provided.

`chrome.tabs.update` is used by `navigate` to load a URL you approved.

**What we don't do with it.**

- We do not monitor which sites you visit outside of an active turn.
- We do not read tab URLs unless the agent needs them for a tool you approved.
- We do not mutate tabs you did not ask us to touch.

---

## `tabGroups`

**What it is.** Lets the extension create, name, color, and assign Chrome tab groups.

**Why we need it.** When you ask Verboo to organize a multi-step research task, the agent can group the tabs it opens under a named, colored group so the work stays visually separated from your other browsing.

**What we don't do with it.**

- We do not read the contents of existing tab groups.
- We do not rename or color your existing tab groups.
- We do not modify a tab group unless you explicitly ask.

---

## Host permissions (`http://*/*`, `https://*/*`, `<all_urls>`)

**What they are.** Match patterns covering HTTP/HTTPS pages, plus `<all_urls>` required by Chrome for `chrome.tabs.captureVisibleTab` (viewport screenshots). Plain `http://*/*` / `https://*/*` alone are **not** accepted by `captureVisibleTab` — Chrome only grants capture with `<all_urls>` or temporary `activeTab`.

**Why we need them.** `chrome.scripting.executeScript`, `chrome.tabs.update`, and viewport screenshots need host access for the page the agent is driving. Restricting patterns to a fixed domain list would make research/automation unusable. `<all_urls>` is required specifically so screenshot works from the side panel without a fresh toolbar-click gesture every turn.

**What we don't do with them.**

- We do not use capture on `chrome://`, `chrome-extension://`, or other restricted schemes from the agent loop (the screenshot tool rejects non-http(s) URLs).
- The script we inject never evaluates a string fetched from a network origin — it is a closed function bundled with the extension.
- Each invocation is gated by `evaluateToolPolicy` and (in Manual mode) requires your explicit approval.

---

## Future permission: `debugger`

**Status:** **NOT YET REQUESTED.** This permission will be re-added explicitly when the agent needs full-page screenshots or sandboxed JavaScript evaluation via the Chrome DevTools Protocol. Until then, viewport-only screenshots use `chrome.tabs.captureVisibleTab`, which does not require `debugger`.

**Why it will be added (later).** To capture screenshots beyond the visible viewport, Chrome requires `chrome.debugger.attach` + `Page.captureScreenshot` with `captureBeyondViewport: true`. To safely evaluate arbitrary JavaScript on a page, the Chrome DevTools Protocol's `Runtime.evaluate` runs in an isolated world — a stronger isolation than `chrome.scripting.executeScript`.

**When it ships.** The Store listing will be updated before publishing. The justification added to the Store will read:

> `debugger` is used only inside the Browser Controller when the agent needs to capture full-page screenshots or evaluate JavaScript in Chrome's isolated world. The debugger is attached on-demand, used for the duration of the single approved tool call, and detached immediately afterward. It is never used to inspect network traffic, modify requests, or fingerprint the user.

**What we won't do with it (even after it is added).**

- We will not use `debugger` to read or modify network requests.
- We will not use `debugger` to read cookies or storage.
- We will not leave a debugger session attached between tool calls.

## Português (Brasil)

Este documento é a fonte de verdade das justificativas de permissão exibidas na Chrome Web Store. Cada justificativa explica **o que** a permissão faz, **por que** precisamos dela e **o que NÃO fazemos** com ela. Ao adicionar ou remover uma permissão, atualize este arquivo no mesmo PR.

### `sidePanel`
Renderiza a UI no side panel do Chrome — é onde vivem o chat, as aprovações de ferramenta, o seletor de modo de permissão e as concessões por site. Não injetamos conteúdo em painéis de outras extensões nem substituímos UI nativa; o painel só aparece quando você clica no ícone do Verboo ou escolhe **Perguntar ao Verboo** após selecionar texto.

### `contextMenus`
Permite adicionar um item ao menu de contexto. O item é **Perguntar ao Verboo** e aparece somente com texto selecionado; ao escolhê-lo, abre o painel lateral da aba e captura o trecho como contexto pendente. Não adicionamos itens para página inteira, imagem, mídia ou histórico: o único item sempre exige uma seleção de texto. Escolher o item não transmite texto: o trecho fica em `chrome.storage.session` até você enviar um turno de chat ou removê-lo, e chega ao modelo cercado como dado não confiável.

### `identity`
Permite ao Chrome abrir e concluir o fluxo OAuth (Authorization Code + PKCE) iniciado pelo usuário, com callback específico da extensão. Não reutilizamos credenciais do CLI, não iniciamos login silencioso e não pedimos token sem clique em **Sign in**; sem client ID registrado, a autenticação falha fechada.

### `storage`
Persiste em `chrome.storage.local`: sessão, modo, concessões, catálogo/seleção de modelos, rotinas e checkpoints. Arquivos escolhidos pelo usuário ficam no IndexedDB da extensão; rascunhos temporários, a gravação ativa e o contexto de texto selecionado usam `chrome.storage.session`. O contexto é descartado quando você o remove ou após o primeiro turno que o usa. Campos de senha, pagamento e segredo são descartados. Nada é sincronizado com a conta Google; o access token só vai aos endpoints do Verboo Router embutidos.

### `alarms` e `notifications`
`alarms` desperta o service worker para horários de rotinas salvas localmente; ocorrências perdidas executam no máximo uma vez. `notifications` avisa quando uma execução precisa de login, modelo, variável, site permitido, janela ou aprovação. Não há agenda remota nem notificações de marketing.

### `nativeMessaging`
Conecta ao host local `com.verboo.code.browser_extension` pelo protocolo de frames do Chrome. O servidor MCP oficial `verboo-in-chrome` usa esse host para encaminhar requisições de ferramentas de navegador do Verboo CLI à extensão com o app desktop fechado. Não enviamos credenciais do CLI, tokens OAuth da extensão, dados de filesystem, comandos de terminal nem operações Git pelo host; o host não chama APIs do Chrome diretamente; aprovações sem side panel falham fechadas; requisições em voo nunca são reexecutadas após desconexão.

### `scripting`
Injeta código nas páginas para `read_page` (ler o DOM), `click`, `type` e medição de viewport para `screenshot` — sempre depois do portão de política (e, em Manual, da sua aprovação). Também lê `window.getSelection()` somente depois de você escolher **Perguntar ao Verboo** no menu de contexto: essa leitura não é iniciada pelo modelo, não modifica a página e fica local até um turno enviado por você. Não injetamos em `chrome://`, `chrome-extension://` ou `about:`; não executamos código de origem remota (as funções são empacotadas na extensão); conteúdo de página só vai ao Verboo Router num turno iniciado por você, cercado como dado não confiável.

### `tabs`
Lista, troca, fecha e abre abas; `chrome.tabs.update` atende o `navigate` aprovado. Não monitoramos sites fora de um turno ativo, não lemos URLs sem necessidade de uma ferramenta aprovada e não mexemos em abas que você não pediu.

### `tabGroups`
Cria, nomeia e colore grupos para tarefas de pesquisa multi-etapas. Não lemos o conteúdo de grupos existentes nem renomeamos/recolorimos os seus, e só modificamos um grupo quando você pede explicitamente.

### Permissões de host (`http://*/*`, `https://*/*`, `<all_urls>`)
`chrome.scripting.executeScript`, `chrome.tabs.update` e screenshots de viewport precisam de acesso ao host da página conduzida; o Chrome só concede `captureVisibleTab` com `<all_urls>` ou `activeTab` temporário. Não capturamos esquemas restritos a partir do loop do agente; o script injetado nunca avalia string vinda da rede; cada invocação passa por `evaluateToolPolicy` e, em Manual, pela sua aprovação.

### Permissão futura: `debugger`
**AINDA NÃO SOLICITADA.** Será adicionada explicitamente quando o agente precisar de screenshots de página inteira (`Page.captureScreenshot` com `captureBeyondViewport: true`) ou avaliação de JavaScript em mundo isolado via CDP. Mesmo então: nunca para ler/modificar tráfego de rede, ler cookies/armazenamento ou manter sessão de debugger anexada entre chamadas. A listagem na Store será atualizada antes da publicação.
