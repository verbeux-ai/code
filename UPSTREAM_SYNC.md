# Upstream Sync Playbook

Verboo Code é um fork do `openclaude` (https://github.com/Gitlawb/openclaude),
que por sua vez originou-se do Claude Code. Este documento descreve como
sincronizar updates do upstream sem perder nossas mudanças de identidade.

## Setup (uma vez)

```bash
# Renomear o origin atual (que aponta para Gitlawb/openclaude) para upstream
git remote rename origin upstream

# Adicionar o origin Verboo (substitua pela URL do seu repo)
git remote add origin git@github.com:verbeux/verboo-code.git

# Verificar
git remote -v
```

## Rotina de sync

```bash
git fetch upstream
git checkout -b sync/upstream-$(date +%Y%m%d)
git merge upstream/main
```

Os arquivos abaixo SEMPRE conflitam por design (são onde nosso rebrand vive).
Resolva preservando nossas mudanças, exceto quando o upstream alterar a lógica
em volta. Use `git grep "VERBOO-BRAND"` para localizar todos os pontos editados.

### Arquivos de marca (preservar nossas mudanças)

#### Identidade visual
- `src/utils/theme.ts` — cores roxas Verboo (`#AD34FE`) em 6 temas: keys
  `claude`, `claudeShimmer`, `clawd_body`, `briefLabelClaude`, mais
  `autoAccept`/`merged` deslocados para ciano (evita colisão visual).
- `src/components/LogoV2/Clawd.tsx` — mascote fantasma 👻 (substitui ASCII
  do clawd). Mantém a função `Clawd` exportada para zero churn em call sites.
- `src/components/LogoV2/WelcomeV2.tsx` — string `"Welcome to Verboo Code"` (3 ocorrências).
- `src/components/IdeOnboardingDialog.tsx` — welcome IDE.
- `src/utils/logoV2Utils.ts` — `'Welcome to Verboo Code'`.

#### CLI / packaging
- `package.json` — `name`, `bin` (`verboo` + `openclaude` alias), `description`,
  `repository.url`, `keywords`.
- `bin/verboo` (novo, canônico) e `bin/openclaude` (alias deprecated).
- `.env.example` — bloco `VERBOO_*` canônico, `OPENCLAUDE_*` como aliases deprecated.
- `README.md`, `PLAYBOOK.md` — rebrand textual completo.

#### `/provider` desregistrado
- `src/commands.ts` — linha de import e entry no array de comandos comentados.
- `src/commands/provider/` — arquivos **NÃO foram deletados** (upstream
  continua mexendo neles; deletar gera conflitos "deleted file modified upstream").

#### Mensagens reescritas
- `src/utils/providerValidation.ts` (3 ocorrências)
- `src/services/api/withRetry.ts`
- `src/services/api/codexUsage.ts`
- `src/services/api/openaiShim.ts`
- `src/components/ProviderManager.tsx`
- `src/utils/attribution.ts` — defaultAttribution e coAuthorDomain.

#### Env vars dual-read
Padrão: `process.env.VERBOO_X ?? process.env.OPENCLAUDE_X`. Aplicado em:
- `src/cost-tracker.ts` (LOG_TOKEN_USAGE)
- `src/ink/terminal.ts` (ENABLE_EXTENDED_KEYS)
- `src/ink/components/App.tsx` (USE_DATA_STDIN, USE_READABLE_STDIN)
- `src/tools/FileReadTool/FileReadTool.ts` (DISABLE_TOOL_REMINDERS)
- `src/utils/messages.ts` (DISABLE_TOOL_REMINDERS, 2 ocorrências)
- `src/utils/attribution.ts` (DISABLE_CO_AUTHORED_BY)
- `src/entrypoints/cli.tsx` (DISABLE_EARLY_INPUT)
- `src/services/api/openaiShim.ts` (DISABLE_STRICT_TOOLS)

Para conferir se algum novo `OPENCLAUDE_*` apareceu no upstream sem alias VERBOO:
```bash
grep -rn "process\.env\.OPENCLAUDE_" src/ | grep -v "VERBOO_"
```

## Convenção de marcadores

Todo bloco rebrand tem prefixo `// VERBOO-BRAND:` para grep rápido:

```bash
git grep "VERBOO-BRAND" src/
```

Antes de cada sync, rode esse comando e mantenha um inventário mental dos
pontos que devem ser preservados.

## Política sobre identifiers Anthropic

Os bundle IDs e endpoints de telemetria com prefixo `com.anthropic.claude_code.*`
**permanecem como upstream**:
- `src/utils/computerUse/common.ts`
- `src/utils/deepLink/registerProtocol.ts`
- `src/utils/settings/mdm/constants.ts`
- `src/utils/telemetry/instrumentation.ts`
- `src/services/analytics/firstPartyEventLogger*.ts`
- `src/utils/claudeInChrome/setup.ts`

Para um SaaS Verboo, a telemetria first-party Anthropic deve estar **desativada**
via flags de runtime ou config. Não renomeie esses identifiers — vai gerar
muitos conflitos de sync sem ganho real.

## Política sobre prompts de tool

Strings com "Claude Code" em `src/tools/*/prompt.ts` **NÃO devem ser
trocadas** para "Verboo Code". Esses prompts treinam o modelo Claude da
Anthropic a reconhecer o ambiente de execução; trocar pode degradar
qualidade de tool-calling.

## Validar após resolver conflitos

```bash
bun run rebrand:check    # falha se literais "OpenClaude"/cor laranja voltaram
bun run typecheck
bun run build
bun test
node dist/cli.mjs --version

# Smoke interativo:
node dist/cli.mjs
# Conferir: splash "Welcome to Verboo Code", cor roxa, 👻, /provider ausente.
```

## Server URL e telemetria

Topologia Verboo está dividida em dois hosts:

- **`router.verboo.ai`** → API LLM (completions, `/v1/messages`, `/v1/models`).
  Equivalente a `api.anthropic.com` no setup original. Override via
  `VERBOO_API_URL` (canônico) ou `ANTHROPIC_BASE_URL` (compat). Aplicado em:
  `src/upstreamproxy/upstreamproxy.ts`, `src/components/StartupScreen.ts`.
- **`code.verboo.ai`** → frontend (gerenciamento de conta, docs, suporte).
  A API de gerenciamento (OAuth, uploads, user mgmt) fica em
  `<VERBOO_WEB_URL>/api`. Override via `VERBOO_WEB_URL`. Aplicado em:
  `src/utils/http.ts` (helper `getVerbooWebUrl`), `src/utils/preflightChecks.tsx`,
  `src/tools/BriefTool/upload.ts` (uploads → `/api`).
- Telemetria first-party Anthropic (1P/Datadog/GrowthBook) já está gated
  off via `isAnalyticsDisabled() === true` em `src/services/analytics/config.ts`
  — herdado do upstream openclaude. Não precisa novo gate.
- `WebFetchTool/utils.ts:checkDomainBlocklist` adicionou gate adicional para
  pular o request a `api.anthropic.com/api/web/domain_info` quando
  `VERBOO_API_URL` está setado (ou `ANTHROPIC_BASE_URL` aponta fora de
  `api.anthropic.com`). Sem deletar código upstream.

## Allowlist de strings

`scripts/rebrand-check.ts` mantém uma allowlist de arquivos onde literais
"OpenClaude" são intencionalmente preservados (testes, features off, prompts
de tool, /provider deprecated). Quando upstream adiciona um arquivo novo
com strings da marca antiga, decida:
1. Se é user-visible → atualizar para "Verboo Code".
2. Se é gated/teste/comment → adicionar caminho à allowlist em
   `scripts/rebrand-check.ts`.
