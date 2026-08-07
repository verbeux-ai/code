# Verboo in Chrome bridge protocol

The packaged Rust helper implements both the stdio MCP server and Chrome Native Messaging host. The desktop app installs and diagnoses it, but is not part of the runtime path.

## Reserved contract

- Host name: `com.verboo.code.browser_extension`
- Protocol version: `1`
- Envelope: `{ version, id, kind, secret?, payload }`
- Kinds: `hello`, `toolRequest`, `turnComplete`, `toolResponse`, `turnCompleteAck`, `error`
- Chrome Native Messaging platform limit: 1 MiB per message (Chrome's own cap on `chrome.runtime.connectNative` frames; not codified in this repo).
- Application payload cap: 64 KiB on `envelope.payload.len()`, enforced by the Rust host (`src-tauri/src/services/browser_bridge.rs:MAX_PAGE_MESSAGE_BYTES = 64 * 1024`). Messages whose payload exceeds this cap are rejected with `MessageTooLarge` before any tool runs.
- Reconnect: the extension reconnects on disconnect with exponential backoff starting at 750 ms, doubling each attempt, capped at 30 s, and never stops trying (`src/native/bridge.js:scheduleReconnect`). In-flight requests at the moment of disconnect are not replayed.

The MCP process discovers a live Native Host through a private, per-user record. Each record contains a random session secret. Local requests are authenticated with that secret, while the secret is removed before the request reaches the extension.

The extension remains the browser controller. Every relayed tool request passes through the canonical catalog, policy gate, and shared approval executor. If an approval is required while the side panel is closed, the extension returns `approval_ui_unavailable` and executes nothing. Disconnected in-flight requests are not replayed.

The bridge never receives or forwards CLI or extension OAuth tokens. Standalone extension chat and CLI authentication remain separate.

The runtime implementation ships atomically with:

1. the Rust Native Messaging host and MCP server;
2. per-user manifest installation for Google Chrome on macOS, Windows, and Linux;
3. a configured production extension ID plus an explicit development ID;
4. version checks, authenticated per-session local transport, and bounded framing;
5. extension tests proving protocol mismatch, malformed-envelope, disconnect, and no-replay behavior.

The per-user installer writes `allowed_origins` for exactly one configured production or development extension ID.

## Português (Brasil)

O helper Rust empacotado implementa tanto o servidor MCP por stdio quanto o host de Native Messaging do Chrome. O app desktop o instala e diagnostica, mas não participa do caminho de runtime.

### Contrato reservado

- Nome do host: `com.verboo.code.browser_extension`
- Versão do protocolo: `1`
- Envelope: `{ version, id, kind, secret?, payload }`
- Kinds: `hello`, `toolRequest`, `turnComplete`, `toolResponse`, `turnCompleteAck`, `error`
- Limite da plataforma Chrome Native Messaging: 1 MiB por mensagem (teto do próprio Chrome sobre quadros de `chrome.runtime.connectNative`; não codificado neste repositório).
- Teto de payload da aplicação: 64 KiB sobre `envelope.payload.len()`, imposto pelo host Rust (`src-tauri/src/services/browser_bridge.rs:MAX_PAGE_MESSAGE_BYTES = 64 * 1024`). Mensagens cujo payload excede esse teto são rejeitadas com `MessageTooLarge` antes de qualquer ferramenta rodar.
- Reconexão: a extensão reconecta em desconexão com backoff exponencial a partir de 750 ms, dobrando a cada tentativa, teto de 30 s, e nunca para de tentar (`src/native/bridge.js:scheduleReconnect`). Requisições em voo no momento da desconexão não são reexecutadas.

O processo MCP descobre um Native Host vivo por um registro privado por usuário contendo um segredo de sessão aleatório. Requisições locais são autenticadas com esse segredo, que é removido antes de a requisição chegar à extensão.

A extensão continua sendo a controladora do navegador: toda requisição relé passa pelo catálogo canônico, pelo portão de política e pelo executor de aprovações compartilhado. Se uma aprovação for necessária com o side panel fechado, a extensão retorna `approval_ui_unavailable` e nada executa. Requisições em voo desconectadas nunca são reexecutadas. A ponte nunca recebe nem encaminha tokens OAuth do CLI ou da extensão; o chat avulso da extensão e a autenticação do CLI permanecem separados. O instalador por usuário grava `allowed_origins` para exatamente um ID de extensão configurado (produção ou desenvolvimento).
