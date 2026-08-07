# Chrome Web Store Listing — Draft

Copy-paste-ready draft for the Chrome Web Store developer dashboard. Keep this file in sync with the actual published listing.

---

## Name

**Verboo Code — Browser Control**

(32 chars. Includes "Verboo" brand keyword. "Browser Control" describes the function for store search.)

---

## Short description (up to 132 chars)

> Control Chrome with Verboo — an AI side panel that navigates, clicks, types, and extracts data, gated by per-tool safety checks.

(131 chars. Includes "Control Chrome with Verboo" tagline and the safety narrative.)

---

## Detailed description

> **Control Chrome with Verboo** — a calm, permission-aware AI side panel that automates the boring parts of web research, form filling, and tab juggling.
>
> Open the side panel from the toolbar, type what you want done ("pull the top 10 results from this SERP", "fill the checkout form with these values"), and the agent works through it with you in control of every step.
>
> ### What it does
>
> - **Navigate, click, type, extract, screenshot, and manage tabs** — the tools you need to drive a browser.
> - **Per-tool safety gate.** Every tool call is evaluated by a policy engine before any Chrome API is touched. Hard blocks on purchases, trades, mass deletion, and credential exposure apply in every mode.
> - **Three permission modes.** Manual (approve each action), Auto (safety checks still apply, fewer prompts), Skip (no routine prompts, hard blocks still enforced).
> - **Per-site grants.** Allow a host once, always, or deny it. Grants are stored locally and never synced.
> - **Reusable routines.** Save instructions, variables, reference files, or a recorded workflow and run it again from a `/` command.
> - **Optional local schedules.** Run a routine daily, weekly, monthly, or annually. Chrome notifies you whenever sign-in or approval is needed.
> - **Verboo account session.** Sign in with your Verboo account. No API key to copy around.
> - **Ask about selected text.** Select text on a page, right-click, and choose **Ask Verboo** to open the side panel with one selected-text context. It stays local and is sent only when the user sends a chat turn.
>
> ### What it does NOT do
>
> - It does not collect analytics or telemetry.
> - It does not read your browsing history.
> - It does not run code fetched from a remote origin — every script is bundled in the extension.
> - It does not touch `chrome://`, `chrome-extension://`, `about:`, or the Chrome Web Store pages.
> - It does not leave a debugger session attached between tool calls.
> - **Standalone chat is explicit.** After extension OAuth, only a turn you start sends your prompt, selected browser context, and browser-tool results to the Verboo Router. Browser text is fenced as untrusted data before model processing.
> - **Selected text is explicit.** Choosing **Ask Verboo** does not transmit the selected text; it is sent only when the user sends a chat turn, then the pending context is discarded.
> - **MCP stays local.** The Verboo in Chrome MCP transport does not copy or forward CLI tokens into the extension.
>
> ### Permissions, in plain English
>
> - **sidePanel** — shows the Verboo panel alongside the page.
> - **contextMenus** — shows **Ask Verboo** only when text is selected, so that choice can open the panel with local pending context.
> - **identity** — opens the user-initiated Verboo OAuth PKCE flow.
> - **storage** — keeps you signed in and stores local settings, routines, and checkpoints.
> - **alarms** — wakes a routine at its locally saved time.
> - **notifications** — tells you when a routine pauses for your attention.
> - **scripting** — runs small scripts in the page you approved to read, click, or fill.
> - **tabs** — manages the tabs the agent works on.
> - **tabGroups** — groups the tabs the agent opens so multi-step research stays organized.
>
> Source: see the repository. Privacy policy: see `PRIVACY.md` in the package.

---

## Category

**Productivity**

---

## Language

**English** (primary). Portuguese (pt-BR) bundled for in-UI strings.

---

## Icon, screenshots, and promo tile

(Owner inserts before submission. Source assets live in `icons/` and a future `store-assets/` directory.)

### Required assets (Chrome Web Store)
- Icon: 128×128 PNG (transparent background not required).
- Small promo tile: 440×280 PNG.
- Marquee promo tile (optional): 1400×560 PNG.

### Screenshot plan (1280×800 or 640×400)
1. Side panel open with the chat prompt and a tool approval card visible.
2. Permission mode selector (Manual / Auto / Skip).
3. Site grants list showing one allowed and one denied host.
4. Routines settings with a `/` command, variables, and an optional schedule.

---

## Privacy practices tab

| Question | Answer |
|---------|--------|
| Does this extension collect user data? | Standalone chat processes the user's prompt, selected browser context, and tool results for a turn the user started. Text selected through **Ask Verboo** stays locally pending until the user sends that turn. OAuth state, model selection, safety grants, and optional routines are stored locally. |
| Is that data transmitted off-device? | Standalone chat sends active-turn data to the Verboo Router after extension OAuth. Selected text is sent only when the user sends a chat turn. The MCP transport is local. |
| Is the data sold or shared with third parties? | No. |
| Does the extension read browsing history? | No. |
| Does the extension run code from a remote origin? | No. |
| Single purpose description | "Provide a browser-automation side panel for a signed-in Verboo account." |

---

## Distribution

- **Visibility:** Public.
- **Regions:** All.
- **Pricing:** Free.

---

## Reviewer notes (paste into the submission form)

> This extension implements `chrome.contextMenus`, `chrome.identity`, `chrome.scripting`, `chrome.tabs`, `chrome.tabGroups`, `chrome.storage`, `chrome.alarms`, `chrome.notifications`, `chrome.sidePanel`, `chrome.activeTab`, and `chrome.runtime.connectNative` (Native Messaging to the locally installed `com.verboo.code.browser_extension` host) to provide a browser-automation side panel with optional local routines. The selected-text menu is limited to text selections; choosing it opens the panel and stores the selected text locally until the user sends a chat turn. There is no remote-loaded code; all injected scripts are bundled. Standalone chat and routine execution use user-initiated OAuth PKCE and send only active-turn instructions, selected reference content, browser context, and tool results to the Verboo Router. Browser content is fenced as untrusted data. Schedules remain local; notifications are used only when a routine needs attention. The local MCP transport connects to the Native Messaging host installed by the Verboo desktop app and carries no CLI token. The extension does not request `debugger` at this time. The full privacy policy is bundled at `PRIVACY.md` and `privacy.html` and linked from the side panel.

## Português (Brasil) — rascunho da listagem pt-BR

Rascunho pronto para o painel da Chrome Web Store no idioma pt-BR. Mantenha em sincronia com a listagem publicada.

### Nome

**Verboo Code — Controle do Navegador**

### Descrição curta (até 132 caracteres)

> Controle o Chrome com o Verboo — um painel lateral de IA que navega, clica, digita e extrai dados, com checagens de segurança.

### Descrição detalhada

> **Controle o Chrome com o Verboo** — um painel lateral de IA, calmo e consciente de permissões, que automatiza as partes chatas de pesquisa na web, preenchimento de formulários e malabarismo de abas.
>
> Abra o painel pela barra de ferramentas, digite o que quer ("puxe os 10 primeiros resultados desta busca", "preencha o formulário de checkout com estes valores") e o agente trabalha com você no controle de cada passo.
>
> **O que ele faz:** navega, clica, digita, extrai, tira screenshots e gerencia abas; com texto selecionado, permite escolher **Perguntar ao Verboo** no menu de contexto para abrir o painel com o trecho como contexto local; salva rotinas reutilizáveis com comando `/`, variáveis, arquivos de referência ou um fluxo gravado; permite agendamento local diário, semanal, mensal ou anual; mantém o portão de segurança por ferramenta (bloqueios rígidos a compras, trades, deleção em massa e exposição de credenciais valem em todos os modos); oferece concessões por site e sessão de conta Verboo sem chave de API para copiar.
>
> **O que ele NÃO faz:** não coleta analytics nem telemetria; não lê seu histórico; não executa código de origem remota; não toca `chrome://`, `chrome-extension://`, `about:` nem a Chrome Web Store; não deixa sessão de debugger anexada; o chat avulso é explícito (só um turno iniciado por você envia dados ao Verboo Router, com o texto do navegador cercado como não confiável); escolher **Perguntar ao Verboo** não transmite o texto selecionado, que só é enviado quando você envia um turno de chat; o MCP permanece local, sem tokens do CLI.
>
> **Permissões em português claro:** sidePanel (mostra o painel), contextMenus (mostra **Perguntar ao Verboo** somente com texto selecionado), identity (OAuth PKCE iniciado por você), storage (sessão, configurações, rotinas e checkpoints locais), alarms (horários locais), notifications (avisos quando uma rotina precisa de você), scripting (scripts pequenos na página aprovada), tabs (abas do trabalho do agente) e tabGroups (organiza pesquisas multi-etapas).

### Categoria, idioma e distribuição

Categoria **Produtividade**; idiomas Inglês (principal) e Português (pt-BR); visibilidade pública, todas as regiões, gratuito. Ativos de imagem e plano de screenshots: mesma lista da seção em inglês.
