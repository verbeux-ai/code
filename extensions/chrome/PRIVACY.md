# Verboo Code — Privacy Policy

**Last updated:** 2026-08-04
**Extension:** Verboo Code — Browser Control
**Version:** 0.3.1

This privacy policy explains what data the Verboo Code browser extension handles when you use it to control Chrome with a Verboo account session.

## Summary

The Verboo extension controls Chrome on your behalf when you give it permission. Standalone chat requires a separate extension OAuth session. After sign-in, a turn sends the user's prompt, selected active-page context, and browser-tool results to the Verboo Router so the selected model can respond. If you select text and choose **Ask Verboo** from Chrome's context menu, that text stays local as pending context and is sent only when you send a chat turn. Browser-derived content is fenced as untrusted data before model processing.

The extension can also save account-scoped routines in the current Chrome profile. A routine may contain instructions, variable defaults, recorded browser steps, an optional schedule, and reference files selected by the user. Routine content is sent to the Verboo Router only when that routine runs. The separate Verboo in Chrome MCP transport is local and does not carry CLI tokens into the extension.

- **No data is sold.**
- **You stay in control** of every action: the extension asks before each potentially destructive step, and you can always deny.
- **Hard blocks cannot be bypassed** — actions like purchasing, financial trades, mass deletion, and credential exposure are blocked even with the most permissive permission mode.

## What the extension accesses

| Data | Why | Where it goes |
|------|-----|---------------|
| Active tab URL and title | To provide selected browser context for a user-started turn | Sent to the Verboo Router only during a standalone chat turn after extension OAuth. |
| Text you explicitly select and choose **Ask Verboo** for | To add the selected text as context in the side panel | Kept temporarily in `chrome.storage.session`; sent to the Verboo Router only when you send a chat turn. It is fenced as untrusted browser data before model processing. |
| Page content and tool results (when you read a page, take a screenshot, click, type, or manage tabs) | To execute tools and let the selected model continue the turn | Sent to the Verboo Router only for a turn you started; text is fenced as untrusted browser data before model processing. |
| Chrome tabs and tab groups | To manage browsing during a turn | Used locally for execution; selected tool results may be included in the active Router turn. |
| Your Verboo account session (account ID and OAuth tokens) | To authenticate standalone chat | Stored locally under `verbooSession`; access tokens are sent to Verboo OAuth/Router endpoints. They are never copied from the CLI. |
| Permission mode (Manual / Auto / Skip) and per-site grants | To enforce your chosen safety level | Stored locally under `chromePermissionMode` and `siteGrants`; never sent anywhere |
| Saved routines, variable defaults, recorded steps, and schedules | To let you repeat browser tasks from `/` commands or a local schedule | Stored in this Chrome profile. Instructions and required reference content are sent to the selected model only when the routine runs. |
| Reference files selected for a routine | To give the selected model the context you chose | Stored in extension IndexedDB. Text and supported images are transmitted only during that routine's execution. |

## What the extension does NOT do

- It does not read your keystrokes outside of tools you explicitly approve.
- It does not track you across sites that the extension is not active on.
- It does not collect analytics, telemetry, or crash reports.
- It does not read or modify pages on internal Chrome URLs (`chrome://`, `chrome-extension://`, `about:`) — these are hard-blocked.
- It does not read or modify content on `chrome.google.com/webstore`.
- It does not store your browsing history.

## Permissions explained

- **`sidePanel`** — Opens the Verboo control panel alongside the page you are on. Without this, the side panel cannot appear.
- **`contextMenus`** — Shows **Ask Verboo** only when you have selected text. Choosing it opens the side panel and keeps that text locally as pending context; it is sent only when you send a chat turn.
- **`identity`** — Opens the user-initiated Verboo OAuth PKCE flow and receives its Chrome extension callback.
- **`storage`** — Stores the extension OAuth session, model cache/selection, permission mode, site grants, saved routines, run checkpoints, and temporary recording state.
- **`alarms`** — Wakes the extension for a routine schedule stored locally. A missed occurrence runs at most once when Chrome becomes available.
- **`notifications`** — Tells you when a scheduled routine is paused because it needs sign-in, a compatible model, an allowed site, a normal window, a variable, or approval.
- **`scripting`** — Injects small scripts into the active tab to read content, click elements, or fill form fields that you approved. Scripts run in the page's own context; the extension does not use `eval`.
- **`tabs`** — Lists, switches, closes, opens, and updates tabs. Used to manage browser state during a turn.
- **`tabGroups`** — Groups browser tabs when you organize a multi-step task.
- **`activeTab`** — Grants temporary access to the focused tab for a user-gesture turn (used as a fallback so `chrome.tabs.captureVisibleTab` can take a viewport screenshot when `<all_urls>` is not the active grant). The extension does not use `activeTab` to read history or persist access after the turn ends.
- **`nativeMessaging`** — Connects to the locally installed `com.verboo.code.browser_extension` host over Chrome's framed stdin/stdout protocol. Used only to relay browser-tool requests from the Verboo CLI MCP server while the desktop app is closed; the host cannot call Chrome APIs directly, and every relayed request still passes through the extension's policy gate and approval executor.
- **`host_permissions` (`http://*/*`, `https://*/*`, `<all_urls>`)** — Required so `scripting` and `tabs` can work on any HTTP/HTTPS page you visit, and so `chrome.tabs.captureVisibleTab` can take a viewport screenshot from the side panel (Chrome does not grant capture with plain `http(s)` patterns alone). The extension cannot read `file://` pages, `chrome://` pages, or other internal URLs — the planner rejects those schemes before any tool runs, regardless of `<all_urls>`.

Future permissions (not yet requested, will be added when needed):

- **`debugger`** — Used only if the agent needs to capture full-page screenshots via the Chrome DevTools Protocol or evaluate JavaScript in a sandbox. This permission will be re-added explicitly when that work ships, and the Store listing will be updated accordingly.

## Where your data lives

All persistent state lives in `chrome.storage.local`, scoped to this extension's profile. Clearing the extension's data removes it. The exact storage keys are:

| Storage key | Module | Contents | Sent off-device? |
|-------------|--------|----------|------------------|
| `verbooSession` | `src/auth/auth.js` | `{ accountId, email?, accessToken, refreshToken?, expiresAt?, source: 'oauth' }` | OAuth/Router endpoints used by standalone chat. |
| `verbooModelsCache` | `src/auth/auth.js` | Model catalog and fetch timestamp | Never directly; it is a local cache of Router metadata. |
| `verbooSelectedModelId` | `src/auth/auth.js` | Selected model identifier | Included in Router requests for user-started turns. |
| `chromePermissionMode` | `src/policy/modesStore.js` | One of `'manual'`, `'auto'`, `'skip'` | Never |
| `siteGrants` | `src/policy/siteGrantsStore.js` | Array of `{ host, decision, updatedAt }` | Never |
| `verbooRoutinesV1` | `src/routines/store.js` | Account-scoped routine definitions, schedules, variables, and recorded steps | Routine instructions are sent only while that routine runs. |
| `verbooRoutineRunsV1` | `src/routines/runStore.js` | Bounded run history, status, checkpoints, and optional recovery suggestion | Never directly; it controls local execution and recovery. |
| `verbooSelectionContexts` | `src/selectionContext.js` | A temporary selected-text context, keyed by tab, until it is sent or dismissed | Sent only when you send the next chat turn with that context; then discarded. |

- The extension OAuth access token is sent only to the bundled Verboo OAuth/Router endpoints.
- The local MCP transport never receives or forwards a CLI token.
- The extension does not run a background server.
- Routine reference files live in the extension-only IndexedDB database `verboo-routines`. Deleting a routine deletes its stored files.
- Temporary routine drafts, active recording metadata, and pending selected-text context use `chrome.storage.session` and are not synced to a Google account. A selected-text context is discarded when you dismiss it or after the first chat turn that uses it.
- Recording listeners are bundled and remain inert until the user starts recording. Password, payment, token, and other sensitive fields are discarded; safe field literals are not written into the saved draft unless the user explicitly resolves them.

## When you are not signed in

If you are not signed in, standalone chat does not call the Verboo Router. The side panel still exposes local permission and site-grant controls.

## Third parties

The extension embeds no third-party scripts, fonts, or trackers. All extension assets are bundled. Standalone inference is requested through the Verboo Router after OAuth.

## Children

The extension is not directed at children under 13 and we do not knowingly collect data from children.

## Changes to this policy

Material changes will be reflected by updating the date at the top. Continued use after a change indicates acceptance of the updated policy.

## Contact

Open an issue on the repository's issues tab. (TODO: confirm the canonical Verboo Code issue tracker URL with the maintainer before publishing to the Store.)

---

## Português (Brasil)

**Última atualização:** 2026-08-04 · **Extensão:** Verboo Code — Browser Control · **Versão:** 0.3.1

Esta política explica quais dados a extensão trata quando você a usa para controlar o Chrome com uma sessão de conta Verboo.

### Resumo

A extensão controla o Chrome em seu nome quando você permite. O chat avulso exige uma sessão OAuth própria da extensão; após o login, um turno envia o prompt, o contexto selecionado da página ativa e os resultados de ferramentas ao Verboo Router. O texto selecionado que você escolhe em **Perguntar ao Verboo** fica local como contexto pendente e só é enviado quando você envia um turno de chat. Conteúdo derivado do navegador é cercado como dado não confiável antes do processamento pelo modelo. Rotinas salvas ficam restritas à conta e ao perfil atual do Chrome; instruções e arquivos de referência só são enviados ao modelo quando a rotina é executada. O transporte MCP do Verboo no Chrome é local e não leva tokens do CLI à extensão.

- **Nenhum dado é vendido.**
- **Você mantém o controle** de cada ação: a extensão pergunta antes de cada passo potencialmente destrutivo e você sempre pode negar.
- **Bloqueios rígidos não podem ser contornados** — compras, operações financeiras, deleção em massa e exposição de credenciais são bloqueadas mesmo no modo mais permissivo.

### O que a extensão acessa

URL/título da aba ativa (contexto de um turno iniciado por você); texto selecionado em **Perguntar ao Verboo** (guardado temporariamente em `chrome.storage.session`, cercado como dado não confiável e enviado só quando você envia um turno de chat); conteúdo de página e resultados de ferramentas (para executar e continuar o turno); abas e grupos (gerenciamento local durante o turno); sua sessão Verboo (ID de conta e tokens OAuth, guardados localmente em `verbooSession` e enviados apenas aos endpoints OAuth/Router do Verboo — nunca copiados do CLI); modo de permissão e concessões por site (guardados localmente, nunca enviados).

### O que a extensão NÃO faz

Não lê suas teclas fora de ferramentas aprovadas; não rastreia sites fora de um turno ativo; não coleta analytics, telemetria ou crash reports; não lê nem modifica `chrome://`, `chrome-extension://`, `about:` nem `chrome.google.com/webstore`; não armazena histórico de navegação.

### Onde seus dados vivem

O estado persistente fica no armazenamento local da extensão, restrito ao perfil atual e sem sincronização com a conta Google. Além das chaves de sessão, modelos e permissões, `verbooRoutinesV1` guarda rotinas e `verbooRoutineRunsV1` guarda um histórico limitado com checkpoints. Arquivos selecionados ficam no IndexedDB `verboo-routines`; rascunhos, gravação ativa e `verbooSelectionContexts` usam `chrome.storage.session`. O contexto de texto selecionado é descartado quando você o remove ou depois do primeiro turno que o usa. A gravação ignora campos de senha, pagamento e segredos. As permissões `alarms` e `notifications` existem somente para agendar rotinas locais e avisar quando uma execução precisa da intervenção do usuário.

### Permissões declaradas (português)

- **`contextMenus`** — mostra **Perguntar ao Verboo** somente com texto selecionado. Ao escolher o item, abre o painel e mantém o trecho local como contexto pendente; ele só é enviado quando você envia um turno de chat.
- **`activeTab`** — acesso temporário à aba focada para o turno iniciado por você (fallback de `chrome.tabs.captureVisibleTab` para screenshot de viewport quando `<all_urls>` não é a concessão ativa). Não lê histórico nem persiste acesso após o turno.
- **`nativeMessaging`** — conecta ao host local `com.verboo.code.browser_extension` pelo protocolo stdin/stdout enquadrado do Chrome. Usada somente para relé de requisições de ferramentas entre o servidor MCP do CLI Verboo e a extensão quando o app desktop está fechado; o host não chama APIs do Chrome diretamente, e toda requisição relé ainda passa pelo portão de política e pelo executor de aprovações da extensão.
- **`host_permissions` (`http://*/*`, `https://*/*`, `<all_urls>`)** — necessárias para que `scripting` e `tabs` atuem em qualquer página HTTP/HTTPS e para que `chrome.tabs.captureVisibleTab` tire screenshot de viewport pelo side panel (Chrome não concede capture só com padrões `http(s)`). A extensão não lê `file://`, `chrome://` nem outras URLs internas — o planner rejeita esses esquemas antes de qualquer ferramenta rodar, independentemente de `<all_urls>`.

### Sem login, terceiros, crianças e alterações

Sem login, o chat avulso não chama o Router (os controles locais de permissão continuam disponíveis). A extensão não embute scripts, fontes ou rastreadores de terceiros. Não é direcionada a menores de 13 anos. Mudanças materiais são refletidas pela data no topo; o uso continuado indica aceitação.

### Contato

Abra uma issue na aba de issues do repositório.
