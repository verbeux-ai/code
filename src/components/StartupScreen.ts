/**
 * VERBOO-BRAND: Verboo Code startup screen — filled-block text logo with
 * Verboo purple gradient. Called once at CLI startup before the Ink UI renders.
 *
 * NOTE: cores aqui são RGB hardcoded (NÃO usam theme.ts) — toda mudança
 * de marca neste arquivo é manual.
 */

import { isLocalProviderUrl, resolveProviderRequest } from '../services/api/providerConfig.js'
import { getLocalOpenAICompatibleProviderLabel } from '../utils/providerDiscovery.js'
import { getSettings_DEPRECATED } from '../utils/settings/settings.js'
import { parseUserSpecifiedModel } from '../utils/model/model.js'
import { containsExactZaiGlmModelId, isZaiBaseUrl } from '../utils/zaiProvider.js'

declare const MACRO: { VERSION: string; DISPLAY_VERSION?: string }

const ESC = '\x1b['
const RESET = `${ESC}0m`
const DIM = `${ESC}2m`

type RGB = [number, number, number]
const rgb = (r: number, g: number, b: number) => `${ESC}38;2;${r};${g};${b}m`

function lerp(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}

function gradAt(stops: RGB[], t: number): RGB {
  const c = Math.max(0, Math.min(1, t))
  const s = c * (stops.length - 1)
  const i = Math.floor(s)
  if (i >= stops.length - 1) return stops[stops.length - 1]
  return lerp(stops[i], stops[i + 1], s - i)
}

function paintLine(text: string, stops: RGB[], lineT: number): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const t = text.length > 1 ? lineT * 0.5 + (i / (text.length - 1)) * 0.5 : lineT
    const [r, g, b] = gradAt(stops, t)
    out += `${rgb(r, g, b)}${text[i]}`
  }
  return out + RESET
}

// ─── Colors ───────────────────────────────────────────────────────────────────

// VERBOO-BRAND: purple gradient for the logo (was sunset orange)
const SUNSET_GRAD: RGB[] = [
  [213, 142, 255], // light purple
  [193, 92, 255],
  [173, 52, 254], // brand #AD34FE
  [146, 1, 243],
  [110, 0, 200],
  [80, 0, 150],
]

const ACCENT: RGB = [173, 52, 254] // VERBOO-BRAND: brand purple
const CREAM: RGB = [220, 200, 240] // VERBOO-BRAND: soft lavender
const DIMCOL: RGB = [120, 100, 140] // VERBOO-BRAND: muted cool gray
const BORDER: RGB = [80, 65, 100] // VERBOO-BRAND: dark cool gray

// ─── Filled Block Text Logo ───────────────────────────────────────────────────

// VERBOO-BRAND: "VERBOO CODE" em uma linha, estilo rounded (cantos \u256d\u256e\u2570\u256f, tra\u00e7os \u2500)
const LOGO_VERBOO_CODE = [
  `  \u2588\u2588\u256e   \u2588\u2588\u256e\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u256e\u2588\u2588\u2588\u2588\u2588\u2588\u256e \u2588\u2588\u2588\u2588\u2588\u2588\u256e  \u2588\u2588\u2588\u2588\u2588\u2588\u256e  \u2588\u2588\u2588\u2588\u2588\u2588\u256e     \u2588\u2588\u2588\u2588\u2588\u2588\u256e \u2588\u2588\u2588\u2588\u2588\u2588\u256e \u2588\u2588\u2588\u2588\u2588\u2588\u256e \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u256e`,
  `  \u2588\u2588\u2502   \u2588\u2588\u2502\u2588\u2588\u256d\u2500\u2500\u2500\u2500\u256f\u2588\u2588\u256d\u2500\u2500\u2588\u2588\u256e\u2588\u2588\u256d\u2500\u2500\u2588\u2588\u256e\u2588\u2588\u256d\u2500\u2500\u2500\u2588\u2588\u256e\u2588\u2588\u256d\u2500\u2500\u2500\u2588\u2588\u256e   \u2588\u2588\u256d\u2500\u2500\u2500\u2500\u256f\u2588\u2588\u256d\u2500\u2500\u2500\u2588\u2588\u256e\u2588\u2588\u256d\u2500\u2500\u2588\u2588\u256e\u2588\u2588\u256d\u2500\u2500\u2500\u2500\u256f`,
  `  \u2588\u2588\u2502   \u2588\u2588\u2502\u2588\u2588\u2588\u2588\u2588\u256e  \u2588\u2588\u2588\u2588\u2588\u2588\u256d\u256f\u2588\u2588\u2588\u2588\u2588\u2588\u256d\u256f\u2588\u2588\u2502   \u2588\u2588\u2502\u2588\u2588\u2502   \u2588\u2588\u2502   \u2588\u2588\u2502     \u2588\u2588\u2502   \u2588\u2588\u2502\u2588\u2588\u2502  \u2588\u2588\u2502\u2588\u2588\u2588\u2588\u2588\u256e  `,
  `  \u2570\u2588\u2588\u256e \u2588\u2588\u256d\u256f\u2588\u2588\u256d\u2500\u2500\u256f  \u2588\u2588\u256d\u2500\u2500\u2588\u2588\u256e\u2588\u2588\u256d\u2500\u2500\u2588\u2588\u256e\u2588\u2588\u2502   \u2588\u2588\u2502\u2588\u2588\u2502   \u2588\u2588\u2502   \u2588\u2588\u2502     \u2588\u2588\u2502   \u2588\u2588\u2502\u2588\u2588\u2502  \u2588\u2588\u2502\u2588\u2588\u256d\u2500\u2500\u256f  `,
  `   \u2570\u2588\u2588\u2588\u2588\u256d\u256f \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u256e\u2588\u2588\u2502  \u2588\u2588\u2502\u2588\u2588\u2588\u2588\u2588\u2588\u256d\u256f\u2570\u2588\u2588\u2588\u2588\u2588\u2588\u256d\u256f\u2570\u2588\u2588\u2588\u2588\u2588\u2588\u256d\u256f   \u2570\u2588\u2588\u2588\u2588\u2588\u2588\u256e\u2570\u2588\u2588\u2588\u2588\u2588\u2588\u256d\u256f\u2588\u2588\u2588\u2588\u2588\u2588\u256d\u256f\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u256e`,
  `    \u2570\u2500\u2500\u2500\u256f  \u2570\u2500\u2500\u2500\u2500\u2500\u2500\u256f\u2570\u2500\u256f  \u2570\u2500\u256f\u2570\u2500\u2500\u2500\u2500\u2500\u256f  \u2570\u2500\u2500\u2500\u2500\u2500\u256f  \u2570\u2500\u2500\u2500\u2500\u2500\u256f     \u2570\u2500\u2500\u2500\u2500\u2500\u256f \u2570\u2500\u2500\u2500\u2500\u2500\u256f \u2570\u2500\u2500\u2500\u2500\u2500\u256f \u2570\u2500\u2500\u2500\u2500\u2500\u2500\u256f`,
]

// ─── Provider detection ───────────────────────────────────────────────────────

export function detectProvider(modelOverride?: string): { name: string; model: string; baseUrl: string; isLocal: boolean } {
  const useGemini = process.env.CLAUDE_CODE_USE_GEMINI === '1' || process.env.CLAUDE_CODE_USE_GEMINI === 'true'
  const useGithub = process.env.CLAUDE_CODE_USE_GITHUB === '1' || process.env.CLAUDE_CODE_USE_GITHUB === 'true'
  const useOpenAI = process.env.CLAUDE_CODE_USE_OPENAI === '1' || process.env.CLAUDE_CODE_USE_OPENAI === 'true'
  const useMistral = process.env.CLAUDE_CODE_USE_MISTRAL === '1' || process.env.CLAUDE_CODE_USE_MISTRAL === 'true'

  if (useGemini) {
    const model = modelOverride || process.env.GEMINI_MODEL || 'gemini-2.0-flash'
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
    else if (/moonshot/i.test(baseUrl)) name = 'Moonshot AI - API'
    else if (/deepseek/i.test(baseUrl)) name = 'DeepSeek'
    else if (/x\.ai/i.test(baseUrl)) name = 'xAI'
    else if (isZaiBaseUrl(baseUrl)) name = 'Z.AI - GLM'
    else if (/mistral/i.test(baseUrl)) name = 'Mistral'
    // rawModel fallback — fires only when base URL is generic/custom.
    else if (/nvidia/i.test(rawModel)) name = 'NVIDIA NIM'
    else if (/minimax/i.test(rawModel)) name = 'MiniMax'
    else if (/\bkimi-for-coding\b/i.test(rawModel))
      name = 'Moonshot AI - Kimi Code'
    else if (/\bkimi-k/i.test(rawModel) || /moonshot/i.test(rawModel))
      name = 'Moonshot AI - API'
    else if (/deepseek/i.test(rawModel)) name = 'DeepSeek'
    else if (/grok/i.test(rawModel)) name = 'xAI'
    else if (containsExactZaiGlmModelId(rawModel)) name = 'Z.AI - GLM'
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

  // VERBOO-BRAND: default provider é Verboo. API LLM hardcoded em
  // code.verboo.ai/api/router (sem overrides — única URL aceita).
  const settings = getSettings_DEPRECATED() || {}
  const modelSetting = modelOverride || settings.model || process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6'
  const resolvedModel = parseUserSpecifiedModel(modelSetting)
  const baseUrl = 'https://code.verboo.ai/api/router'
  const isLocal = isLocalProviderUrl(baseUrl)
  return { name: 'Verboo', model: resolvedModel, baseUrl, isLocal }
}

// ─── Box drawing ──────────────────────────────────────────────────────────────

function boxRow(content: string, width: number, rawLen: number): string {
  const pad = Math.max(0, width - 2 - rawLen)
  return `${rgb(...BORDER)}\u2502${RESET}${content}${' '.repeat(pad)}${rgb(...BORDER)}\u2502${RESET}`
}

// ─── Main ─────────────────────────────────────────────────────────────────────

// VERBOO-BRAND: compact rounded header (replaces giant ASCII splash).
// Layout inspired by the V2 logo style \u2014 fantasma + name + meta on the right.
export function printStartupScreen(modelOverride?: string): void {
  // Skip in non-interactive / CI / print mode
  if (process.env.CI || !process.stdout.isTTY) return

  const p = detectProvider(modelOverride)
  const out: string[] = []

  // Resolve cwd to a tilde-shortened display path
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const cwd = process.cwd()
  const displayCwd = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd

  const version = MACRO.DISPLAY_VERSION ?? MACRO.VERSION
  const bold = `${ESC}1m`
  const PURPLE = rgb(...ACCENT)
  const SOFT = rgb(...CREAM)
  const DIMP = `${DIM}${rgb(...DIMCOL)}`
  const STATUS_C = p.isLocal ? rgb(130, 200, 140) : PURPLE
  const statusLabel = p.isLocal ? 'local' : 'cloud'
  const ep = p.baseUrl.length > 48 ? p.baseUrl.slice(0, 45) + '...' : p.baseUrl

  out.push('')
  out.push(`  ${PURPLE}\ud83d\udc7b${RESET}  ${bold}${SOFT}Verboo Code${RESET} ${DIMP}v${version}${RESET}`)
  out.push(`      ${DIMP}Tokens ilimitados \u00b7 Privacidade \u00b7 Velocidade${RESET}`)
  out.push(`      ${DIMP}${p.name} \u00b7 ${p.model}${RESET}`)
  out.push(`      ${DIMP}${ep}${RESET}`)
  out.push(`      ${DIMP}${displayCwd}${RESET}`)
  out.push('')
  out.push(`  ${STATUS_C}\u25cf${RESET}  ${DIMP}${statusLabel}${RESET}    ${DIMP}Ready \u2014 type ${RESET}${PURPLE}/help${RESET}${DIMP} to begin${RESET}`)
  out.push('')

  process.stdout.write(out.join('\n') + '\n')
}
