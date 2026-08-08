/**
 * Minimal Verboo Code identity printed once before the Ink UI renders.
 * Keep this compact: the terminal is a workspace, not a splash screen.
 */

import { VERBOO_ROUTER_URL, isVerbooMode } from '../constants/oauth.js'
import { isLocalProviderUrl, resolveProviderRequest } from '../services/api/providerConfig.js'
import { getCachedVerbooModels } from '../services/api/verbooModels.js'
import { getLocalOpenAICompatibleProviderLabel } from '../utils/providerDiscovery.js'
import { getDefaultVerbooModel, getUserSpecifiedModelSetting, isClaudeModelLike, parseUserSpecifiedModel } from '../utils/model/model.js'
import { containsExactZaiGlmModelId, isZaiBaseUrl } from '../utils/zaiProvider.js'

declare const MACRO: { VERSION: string; DISPLAY_VERSION?: string }

const ESC = '\x1b['
const RESET = `${ESC}0m`
const DIM = `${ESC}2m`

const rgb = (r: number, g: number, b: number) => `${ESC}38;2;${r};${g};${b}m`

const ACCENT = [173, 52, 254] as const
const DIMCOL = [120, 100, 140] as const
const STARTUP_DEFAULT_COLUMNS = 80

// Original Verboo mascot. Keep this code-native so it renders consistently in
// terminals without depending on the platform's emoji artwork.
const VERBOO_LOGO = [
  '  ▄▀▀▀▀▀▀▀▄  ',
  '▄▀▀▀▀▀▀▀▀▀▀▀▄',
  '▀▀▀ ▀▀▀▀▀ ▀▀▀',
  '▀▀▀▀▀▀▀▀▀▀▀▀▀',
  '▀▀▀▀▀▄▄▄▀▀▀▀▀',
  ' ▀▀▀▀▀▀▀▀▀▀▀ ',
  '▄▀▀ ▀▀▀▀▀ ▀▀▄',
]

const VERBOO_LOGO_MASK = [
  '  011111110  ',
  '0111111111110',
  '1110111110111',
  '1111011101111',
  '1111100011111',
  ' 11111111111 ',
  '110 01110 011',
]

const STARTUP_LOGO_MIN_COLUMNS = 48

// ─── Provider detection ───────────────────────────────────────────────────────

function resolveVerbooStartupModel(modelOverride?: string): string {
  const cachedModels = getCachedVerbooModels()
  const resolveIfAvailable = (model: unknown): string | undefined => {
    if (typeof model !== 'string') return undefined
    const trimmed = model.trim()
    if (!trimmed || isClaudeModelLike(trimmed)) return undefined

    const resolved = parseUserSpecifiedModel(trimmed)
    if (isClaudeModelLike(resolved)) return undefined

    if (cachedModels !== null) {
      return cachedModels.some(m => m.id === resolved && !isClaudeModelLike(m.id))
        ? resolved
        : undefined
    }

    return resolved
  }

  return (
    resolveIfAvailable(modelOverride) ??
    resolveIfAvailable(getUserSpecifiedModelSetting()) ??
    cachedModels?.find(model => !isClaudeModelLike(model.id))?.id ??
    getDefaultVerbooModel()
  )
}

export function detectProvider(modelOverride?: string): { name: string; model: string; baseUrl: string; isLocal: boolean } {
  if (isVerbooMode()) {
    const baseUrl = VERBOO_ROUTER_URL
    const isLocal = isLocalProviderUrl(baseUrl)
    return {
      name: 'Verboo',
      model: resolveVerbooStartupModel(modelOverride),
      baseUrl,
      isLocal,
    }
  }

  const useGemini = process.env.CLAUDE_CODE_USE_GEMINI === '1' || process.env.CLAUDE_CODE_USE_GEMINI === 'true'
  const useGithub = process.env.CLAUDE_CODE_USE_GITHUB === '1' || process.env.CLAUDE_CODE_USE_GITHUB === 'true'
  const useOpenAI = process.env.CLAUDE_CODE_USE_OPENAI === '1' || process.env.CLAUDE_CODE_USE_OPENAI === 'true'
  const useMistral = process.env.CLAUDE_CODE_USE_MISTRAL === '1' || process.env.CLAUDE_CODE_USE_MISTRAL === 'true'

  if (useGemini) {
    const model = modelOverride || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL
    const baseUrl = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai'
    return { name: 'Google Gemini', model, baseUrl, isLocal: false }
  }

  if (useMistral) {
    const model = modelOverride || process.env.MISTRAL_MODEL || 'devstral-latest'
    const baseUrl = process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1'
    return { name: 'Mistral', model, baseUrl, isLocal: false }
  }

  if (useGithub) {
    const model = modelOverride || process.env.OPENAI_MODEL || 'github:copilot'
    const baseUrl =
      process.env.OPENAI_BASE_URL || 'https://api.githubcopilot.com'
    return { name: 'GitHub Copilot', model, baseUrl, isLocal: false }
  }

  if (useOpenAI) {
    const rawModel = modelOverride || process.env.OPENAI_MODEL || 'gpt-4o'
    const resolvedRequest = resolveProviderRequest({
      model: rawModel,
      baseUrl: process.env.OPENAI_BASE_URL,
    })
    const baseUrl = resolvedRequest.baseUrl
    const isLocal = isLocalProviderUrl(baseUrl)
    const routeId = resolveRouteIdFromBaseUrl(baseUrl)
    let name = 'OpenAI'
    // Explicit dedicated-provider env flags win.
    if (process.env.NVIDIA_NIM) name = 'NVIDIA NIM'
    else if (process.env.MINIMAX_API_KEY) name = 'MiniMax'
    else if (
      resolvedRequest.transport === 'codex_responses' ||
      baseUrl.includes('chatgpt.com/backend-api/codex')
    )
      name = 'Codex'
    // Base URL is authoritative — must precede rawModel checks so aggregators
    // (OpenRouter/Together/Groq) aren't mislabelled as DeepSeek/Kimi/etc.
    // when routed to models whose IDs contain a vendor prefix. See issue #855.
    else if (/openrouter/i.test(baseUrl)) name = 'OpenRouter'
    else if (/together/i.test(baseUrl)) name = 'Together AI'
    else if (/groq/i.test(baseUrl)) name = 'Groq'
    else if (/azure/i.test(baseUrl)) name = 'Azure OpenAI'
    else if (/nvidia/i.test(baseUrl)) name = 'NVIDIA NIM'
    else if (/minimax/i.test(baseUrl)) name = 'MiniMax'
    else if (/api\.kimi\.com/i.test(baseUrl)) name = 'Moonshot AI - Kimi Code'
    else if (routeId && routeId !== 'openai' && routeId !== 'custom')
      name = getRouteLabel(routeId) ?? name
    else if (/moonshot/i.test(baseUrl)) name = 'Moonshot AI - API'
    else if (/deepseek/i.test(baseUrl)) name = 'DeepSeek'
    else if (/mistral/i.test(baseUrl)) name = 'Mistral'
    // rawModel fallback — fires only when base URL is generic/custom.
    else if (/nvidia/i.test(rawModel)) name = 'NVIDIA NIM'
    else if (/minimax/i.test(rawModel)) name = 'MiniMax'
    else if (/\bkimi-for-coding\b/i.test(rawModel))
      name = 'Moonshot AI - Kimi Code'
    else if (/\bkimi-k/i.test(rawModel) || /moonshot/i.test(rawModel))
      name = 'Moonshot AI - API'
    else if (/deepseek/i.test(rawModel)) name = 'DeepSeek'
    else if (/mistral/i.test(rawModel)) name = 'Mistral'
    else if (/llama/i.test(rawModel)) name = 'Meta Llama'
    else if (/bankr/i.test(baseUrl)) name = 'Bankr'
    else if (/bankr/i.test(rawModel)) name = 'Bankr'
    else if (isLocal) name = getLocalOpenAICompatibleProviderLabel(baseUrl)
    
    // Resolve model alias to actual model name + reasoning effort
    let displayModel = resolvedRequest.resolvedModel
    if (resolvedRequest.reasoning?.effort) {
      displayModel = `${displayModel} (${resolvedRequest.reasoning.effort})`
    }
    
    return { name, model: displayModel, baseUrl, isLocal }
  }

  // VERBOO-BRAND: default provider é Verboo. API LLM via router em code.verboo.ai/router.
  const modelSetting = modelOverride || getDefaultVerbooModel()
  const resolvedModel = parseUserSpecifiedModel(modelSetting)
  const baseUrl = VERBOO_ROUTER_URL
  const isLocal = isLocalProviderUrl(baseUrl)
  return { name: 'Verboo', model: resolvedModel, baseUrl, isLocal }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function truncateStartupText(text: string, maxLength: number): string {
  if (maxLength <= 0) return ''
  if (text.length <= maxLength) return text
  if (maxLength === 1) return '\u2026'
  return `${text.slice(0, maxLength - 1)}\u2026`
}

export function renderStartupScreen(
  p: ReturnType<typeof detectProvider>,
  version: string,
  displayCwd: string,
  columns: number,
): string {
  const out: string[] = ['']
  const bold = `${ESC}1m`
  const PURPLE = rgb(...ACCENT)
  const PURPLE_FILL = `${PURPLE}${ESC}48;2;${ACCENT[0]};${ACCENT[1]};${ACCENT[2]}m`
  const DIMP = `${DIM}${rgb(...DIMCOL)}`
  const STATUS_C = p.isLocal ? rgb(130, 200, 140) : PURPLE
  const statusLabel = p.isLocal ? 'local' : 'cloud'
  const providerAndModel = p.name === 'Verboo' ? p.model : `${p.name} · ${p.model}`

  if (columns < STARTUP_LOGO_MIN_COLUMNS) {
    const detailWidth = Math.max(1, columns - 4)
    const shownVersion = truncateStartupText(version, Math.max(1, columns - 20))
    const model = truncateStartupText(providerAndModel, Math.max(1, detailWidth - statusLabel.length - 4))
    const cwd = truncateStartupText(displayCwd, detailWidth)

    out.push(`  ${bold}${PURPLE}Verboo Code${RESET} ${DIMP}v${shownVersion}${RESET}`)
    out.push(`  ${STATUS_C}●${RESET} ${DIMP}${model} · ${statusLabel}${RESET}`)
    out.push(`  ${DIMP}${cwd}${RESET}`)
  } else {
    const maxLogoWidth = Math.max(...VERBOO_LOGO.map(line => line.trimEnd().length))
    const logoTextPadding = 2
    const rightTextWidth = Math.max(1, columns - 2 - maxLogoWidth - logoTextPadding)
    const shownVersion = truncateStartupText(version, Math.max(1, rightTextWidth - 16))
    const model = truncateStartupText(providerAndModel, Math.max(1, rightTextWidth - statusLabel.length - 5))
    const cwd = truncateStartupText(displayCwd, rightTextWidth)
    const hint = truncateStartupText('Type a request, or use /help for commands', rightTextWidth)
    const rightColumn = [
      '',
      `${bold}${PURPLE}Verboo Code${RESET} ${DIMP}v${shownVersion}${RESET}`,
      `${STATUS_C}●${RESET} ${DIMP}${model} · ${statusLabel}${RESET}`,
      `${DIMP}${cwd}${RESET}`,
      '',
      `${DIMP}${hint}${RESET}`,
      '',
    ]

    for (let i = 0; i < VERBOO_LOGO.length; i++) {
      const line = (VERBOO_LOGO[i] ?? '').trimEnd()
      const mask = VERBOO_LOGO_MASK[i] ?? ''
      let painted = ''

      for (let j = 0; j < line.length; j++) {
        const character = line[j] ?? ''
        const isBlock = character === '▀' || character === '▄'
        painted += isBlock && mask[j] === '1'
          ? `${PURPLE_FILL}${character}${RESET}`
          : isBlock
            ? `${PURPLE}${character}${RESET}`
            : character
      }

      const gap = ' '.repeat(Math.max(0, maxLogoWidth - line.length + logoTextPadding))
      out.push(`  ${painted}${gap}${rightColumn[i] ?? ''}`)
    }
  }

  out.push('')

  return `${out.join('\n')}\n`
}

// VERBOO-BRAND: compact identity shared by every interactive startup.
export function printStartupScreen(modelOverride?: string): void {
  // Skip in non-interactive / CI / print mode
  if (process.env.CI || !process.stdout.isTTY) return

  const p = detectProvider(modelOverride)

  // Resolve cwd to a tilde-shortened display path
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const cwd = process.cwd()
  const displayCwd = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd

  const version = MACRO.DISPLAY_VERSION ?? MACRO.VERSION
  const columns = process.stdout.columns ?? STARTUP_DEFAULT_COLUMNS
  process.stdout.write(renderStartupScreen(p, version, displayCwd, columns))
}
