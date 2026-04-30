#!/usr/bin/env bun
/**
 * VERBOO-BRAND: rebrand regression check.
 *
 * Roda após `git merge upstream/main` e em CI para garantir que literais
 * antigos do upstream openclaude/Claude Code não voltaram em pontos onde
 * a marca Verboo deve prevalecer.
 *
 * Exit 0 = clean, exit 1 = regressões encontradas.
 *
 * Uso: bun run scripts/rebrand-check.ts
 *
 * Allowlist é intencional — refletindo as decisões em UPSTREAM_SYNC.md:
 *  - identifiers Anthropic (bundle IDs, telemetria) preservados
 *  - prompts de tool com "Claude Code" preservados
 *  - bin/openclaude alias deprecated mantido
 *  - OPENCLAUDE_* env var aliases mantidos
 */

import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

type Rule = {
  name: string
  pattern: RegExp
  /** Files/paths where matches are allowed (substring match against repo-relative path). */
  allowlist: string[]
}

/**
 * Allowlist comum reflete as decisões em UPSTREAM_SYNC.md:
 *  - testes referenciam comportamento upstream original
 *  - features desligadas no open build (BRIDGE_MODE, etc.) não vão para o
 *    bundle final, então literais ali não vazam para usuários
 *  - /provider command está desregistrado, mas arquivos persistem para
 *    minimizar conflitos de merge
 *  - prompts de tool em src/tools/[A-Z]*Tool preservam wording original
 *    (afeta tool-calling do modelo)
 */
const COMMON_ALLOWLIST = [
  'UPSTREAM_SYNC.md',
  'CHANGELOG.md',
  'PLAYBOOK.md',
  'README.md',
  'CONTRIBUTING.md',
  'docs/',
  'scripts/rebrand-check.ts',
  '.test.ts',
  '.test.tsx',
  '.test.mjs',
  'src/__tests__',
  // Features off in open build (gated by feature() flags = false):
  'src/bridge/',
  'src/buddy/',
  'src/remote/',
  'src/voice/',
  'src/grpc/',
  'src/proto/',
  'src/components/tasks/RemoteSessionDetailDialog.tsx',
  'src/components/ClaudeInChromeOnboarding.tsx',
  'src/utils/claudeInChrome/',
  'src/utils/computerUse/',
  'src/utils/deepLink/',
  'src/utils/telemetry/',
  // /provider deprecated, files retained for merge:
  'src/commands/provider/',
  'src/components/ProviderManager.tsx',
  'src/utils/providerProfiles.ts',
  'src/utils/providerValidation.ts',
  // Tool prompts intentionally preserve openclaude/Claude Code wording:
  'src/tools/',
  // Telemetry already gated off via isAnalyticsDisabled():
  'src/services/analytics/',
  // Internal install/launch utilities for openclaude alias:
  'openclaudeInstallSurfaces',
  'provider-launch.ts',
  'provider-bootstrap.ts',
  'start-grpc.ts',
  // Code comments / build infra (not user-visible):
  'src/ink/colorize.ts',
  'src/ink/terminal.ts',
  'src/utils/buildConfig.ts',
  'src/utils/model/modelCache.ts',
  'src/utils/model/openaiContextWindows.ts',
  'src/utils/model/benchmark.ts',
  'src/utils/githubModelsCredentials.ts',
  'src/cli/update.ts',
  'src/services/api/openaiShim.ts',
  'src/services/api/codexUsage.ts',
  'src/services/api/withRetry.ts',
  'src/entrypoints/cli.tsx',
  'src/entrypoints/mcp.ts',
  // Features off / Anthropic-specific (gated or deprecated):
  'src/commands/buddy/',
  'src/commands/chrome/',
  'src/commands/thinkback/',
  'src/commands/ultraplan.tsx',
  'src/commands/review.ts',
  'src/commands/feedback/',
  'src/hooks/useVoice.ts',
  'src/services/voice.ts',
  'src/hooks/notifs/useNpmDeprecationNotification.tsx',
  'src/commands/remote-setup/',
  'src/commands/install.tsx',
  'src/commands/stickers/',
  'src/commands/issue.ts',
  'src/commands/share.tsx',
  'src/commands/upgrade/',
  'src/commands/feedback.tsx',
  'src/utils/openclaudeFingerprint.ts',
  'src/utils/openclaudeUpdate.ts',
  'src/utils/openclaudeProcessManager.ts',
  'src/utils/openclaudeInstall.ts',
  'src/utils/configMigration.ts',
  'src/utils/auth/',
  'src/utils/uninstaller/',
  'src/components/HelpV2/',
  'src/services/api/filesApi.ts',
]

const RULES: Rule[] = [
  {
    name: 'OpenClaude product literal',
    pattern: /\b(OpenClaude|Open Claude|OPEN CLAUDE)\b/,
    allowlist: [
      ...COMMON_ALLOWLIST,
      // CLI brand fallback gated por VERBOO_CLI_BRAND=openclaude (alias deprecated):
      'src/main.tsx',
    ],
  },
  {
    name: '@gitlawb npm scope',
    pattern: /@gitlawb\//,
    allowlist: COMMON_ALLOWLIST,
  },
  {
    name: 'Old orange brand color rgb(215,119,87)',
    pattern: /rgb\(\s*215\s*,\s*119\s*,\s*87\s*\)/,
    allowlist: COMMON_ALLOWLIST,
  },
  {
    name: 'Old orange brand color #da7756',
    pattern: /#da7756/i,
    allowlist: COMMON_ALLOWLIST,
  },
  {
    name: 'Hardcoded api.anthropic.com (must use VERBOO_API_URL precedence)',
    pattern: /['"`]https:\/\/api\.anthropic\.com['"`]/,
    allowlist: [
      ...COMMON_ALLOWLIST,
      // OAuth flow ainda aponta para Anthropic (deferred per /login plan):
      'src/constants/oauth.ts',
      // upstreamproxy mantém api.anthropic.com como último fallback explícito:
      'src/upstreamproxy/upstreamproxy.ts',
      // WebFetchTool já gateado por VERBOO_API_URL (verificado em rebrand-check):
      'src/tools/WebFetchTool/utils.ts',
      // filesApi: gated pelo OAuth (deferred):
      'src/services/api/filesApi.ts',
      // StartupScreen mostra base URL (corrigido em separado):
      'src/components/StartupScreen.ts',
    ],
  },
  {
    // Captura "Anthropic" apenas dentro de strings (aspas simples, duplas ou
    // template literals). NÃO captura imports de SDK, comments, tipos, env vars,
    // bundle IDs. Apenas strings em runtime que podem aparecer ao usuário.
    name: 'User-visible "Anthropic" literal (use Verboo)',
    pattern:
      /['"`][^'"`]*\bAnthropic\b(?!\.|_|-(?:ai|version|beta|api)|\/(?:alwaysLoad|beta))[^'"`]*['"`]/,
    allowlist: [
      ...COMMON_ALLOWLIST,
      // OAuth flow (deferred):
      'src/constants/oauth.ts',
      'src/main.tsx',  // OAuth getOauthConfig contém refs upstream Anthropic
      // SDK error logger uses preserved upstream identifier strings:
      'src/services/api/sdk.ts',
      // Auth/account model functions reference "Anthropic" provider type:
      'src/utils/auth.ts',
      'src/utils/auth/',
      'src/cli/handlers/auth.ts',  // restantes refs em código de fluxo
      // Provider type internals (compat com upstream):
      'src/utils/providerFlag.ts',
      'src/utils/providerAutoDetect.ts',
      'src/utils/api.ts',
      'src/utils/managedEnv.ts',
      'src/utils/proxy.ts',
      'src/utils/preauth.ts',
      'src/utils/oauthState.ts',
      // Internal repo allowlist (security):
      'src/utils/commitAttribution.ts',
      'src/utils/desktopDeepLink.ts',
      // Plugin marketplace security:
      'src/utils/plugins/schemas.ts',
      // VCR / test fixtures:
      'src/services/vcr.ts',
      'src/services/api/vcrFixtures.ts',
      // SDK schema docs:
      'src/entrypoints/sdk/coreSchemas.ts',
      'src/entrypoints/sdk/',
      // Settings schema docs:
      'src/utils/settings/types.ts',
      // PackageManagerAutoUpdater references winget pkg id "Anthropic.ClaudeCode":
      'src/components/PackageManagerAutoUpdater.tsx',
      // Skills bundled docs:
      'src/skills/bundled/',
      // Grove (Anthropic-specific feature):
      'src/components/grove/',
      'src/commands/grove/',
      // Coordinator example mentions anthropics/claude-code repo:
      'src/coordinator/',
      // Pre-approved domains list (security):
      'src/tools/WebFetchTool/preapproved.ts',
      // Internal Tool meta key constants (MCP spec):
      'src/Tool.ts',
      // Voice keyterms (gated VOICE_MODE):
      'src/services/voiceKeyterms.ts',
    ],
  },
]

const SCAN_ROOTS = ['src', 'bin', 'scripts', 'package.json', '.env.example']
const IGNORE_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'coverage',
  '.next',
  'build',
])
const IGNORE_FILE_EXT = new Set(['.lock', '.lockb', '.png', '.jpg', '.gif'])

function* walk(root: string): Generator<string> {
  let stat
  try {
    stat = statSync(root)
  } catch {
    return
  }
  if (stat.isFile()) {
    yield root
    return
  }
  if (!stat.isDirectory()) return
  for (const entry of readdirSync(root)) {
    if (IGNORE_DIRS.has(entry)) continue
    const full = join(root, entry)
    let s
    try {
      s = statSync(full)
    } catch {
      continue
    }
    if (s.isDirectory()) {
      yield* walk(full)
    } else if (s.isFile()) {
      const ext = entry.includes('.') ? entry.slice(entry.lastIndexOf('.')) : ''
      if (IGNORE_FILE_EXT.has(ext)) continue
      yield full
    }
  }
}

type Hit = { rule: string; file: string; line: number; text: string }

function scan(): Hit[] {
  const cwd = process.cwd()
  const hits: Hit[] = []
  for (const root of SCAN_ROOTS) {
    for (const file of walk(root)) {
      const rel = relative(cwd, file)
      let content
      try {
        content = readFileSync(file, 'utf-8')
      } catch {
        continue
      }
      const lines = content.split('\n')
      for (const rule of RULES) {
        if (rule.allowlist.some(a => rel.includes(a))) continue
        for (let i = 0; i < lines.length; i++) {
          if (rule.pattern.test(lines[i])) {
            hits.push({
              rule: rule.name,
              file: rel,
              line: i + 1,
              text: lines[i].trim().slice(0, 160),
            })
          }
        }
      }
    }
  }
  return hits
}

function main(): void {
  const hits = scan()
  if (hits.length === 0) {
    console.log('rebrand-check: clean (0 regressões).')
    process.exit(0)
  }

  console.error(`rebrand-check: ${hits.length} regressão(ões) encontrada(s):\n`)
  const byRule = new Map<string, Hit[]>()
  for (const h of hits) {
    if (!byRule.has(h.rule)) byRule.set(h.rule, [])
    byRule.get(h.rule)!.push(h)
  }
  for (const [rule, list] of byRule) {
    console.error(`  [${rule}] (${list.length})`)
    for (const h of list.slice(0, 20)) {
      console.error(`    ${h.file}:${h.line}  ${h.text}`)
    }
    if (list.length > 20) {
      console.error(`    ... +${list.length - 20} mais`)
    }
  }
  console.error('\nResolução: ou ajuste o arquivo (preferido), ou adicione o caminho')
  console.error('à allowlist em scripts/rebrand-check.ts se for caso documentado em')
  console.error('UPSTREAM_SYNC.md (identifiers Anthropic, prompts de tool, alias bin).')
  process.exit(1)
}

main()
