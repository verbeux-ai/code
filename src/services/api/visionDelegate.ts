import { createHash } from 'crypto'
import { getModel } from '../../integrations/registry.js'
import { logForDebugging } from '../../utils/debug.js'
import { getCachedVerbooModels } from './verbooModels.js'

/**
 * Vision delegation: guarantees that no image block ever reaches a model
 * without vision support. When the active model lacks vision, every image in
 * the outgoing message array (pasted screenshots, FileRead of images, MCP tool
 * results such as browser screenshots) is analyzed once by a vision-capable
 * router model and replaced by its text analysis. Without this, a single
 * image poisons the whole session: history is resent on every turn, so the
 * provider rejects every subsequent request (HTTP 400).
 *
 * Config:
 *   VERBOO_VISION_DELEGATE = auto (default) | off
 *   VERBOO_VISION_MODEL    = pin a specific router model id
 */

const FALLBACK_VISION_MODEL = 'qwen3.6-27b'

// Id heuristics used when the registry has no descriptor for a model id.
// NON_VISION is checked first (a "qwen3-coder" id must not match "qwen").
const NON_VISION_ID_HINTS = [
  'deepseek',
  'coder',
  'glm',
  'gemma',
  'kimi',
  'embed',
  'whisper',
  'tts',
]
const VISION_ID_HINTS = [
  'qwen',
  'vl',
  'vision',
  'gemini',
  'gpt-4o',
  'gpt-5',
  'pixtral',
  'llava',
  'internvl',
  'minicpm',
  'claude',
]

/** Analysis text injected in place of an image block. */
export function visionAnalysisMarker(model: string): string {
  return `[Image analyzed by ${model}]`
}

export const IMAGE_REMOVED_PLACEHOLDER =
  '[image removed: target model has no vision support]'

export function isVisionDelegationEnabled(): boolean {
  return (process.env.VERBOO_VISION_DELEGATE ?? 'auto').toLowerCase() !== 'off'
}

/**
 * Whether a router model id supports vision. Registry descriptors win; id
 * heuristics are the fallback. Unknown ids resolve to `false` — delegating
 * is always safe, sending an image to a blind model never is.
 */
export function modelSupportsVision(modelId: string): boolean {
  if (!modelId) return false

  // Router ids may carry route prefixes ('qwen3.6-27b',
  // 'pro/@preset/...') — try progressively stripped candidates.
  const segments = modelId.split('/')
  const candidates = new Set<string>([
    modelId,
    segments.slice(1).join('/'),
    segments[segments.length - 1] ?? '',
  ])
  for (const candidate of candidates) {
    if (!candidate) continue
    const descriptor = getModel(candidate)
    if (descriptor?.capabilities) {
      return descriptor.capabilities.supportsVision === true
    }
  }

  const lower = modelId.toLowerCase()
  if (NON_VISION_ID_HINTS.some(hint => lower.includes(hint))) {
    return false
  }
  return VISION_ID_HINTS.some(hint => lower.includes(hint))
}

/**
 * Pick the vision model to delegate to.
 * Priority: VERBOO_VISION_MODEL env > vision-capable model from the cached
 * router catalog (populated at startup) > constant fallback.
 */
export function pickVisionModel(): string {
  const pinned = process.env.VERBOO_VISION_MODEL
  if (pinned) return pinned

  const cached = getCachedVerbooModels()
  if (cached) {
    if (cached.some(m => m.id === FALLBACK_VISION_MODEL)) {
      return FALLBACK_VISION_MODEL
    }
    const vision = cached.find(m => modelSupportsVision(m.id))
    if (vision) return vision.id
  }
  return FALLBACK_VISION_MODEL
}

// ---------------------------------------------------------------------------
// Message scanning / rewriting
// ---------------------------------------------------------------------------

type Block = Record<string, unknown>
type ShimMessage = {
  role?: string
  message?: { role?: string; content?: unknown }
  content?: unknown
  [key: string]: unknown
}

/** One vision call: the image blocks of a single user message or tool_result. */
type ImageGroup = {
  images: Block[]
  context: string
}

export type VisionCaller = (args: {
  model: string
  images: Block[]
  prompt: string
}) => Promise<string>

function getContent(msg: ShimMessage): unknown {
  return msg.message?.content ?? msg.content
}

function isImageBlock(block: unknown): block is Block {
  return (
    !!block &&
    typeof block === 'object' &&
    (block as Block).type === 'image'
  )
}

function imageHash(block: Block): string {
  const source = block.source as
    | { data?: string; url?: string }
    | undefined
  const payload = source?.data ?? source?.url ?? JSON.stringify(block)
  return createHash('sha256').update(payload).digest('hex')
}

function groupKey(images: Block[]): string {
  return images.map(imageHash).join('+')
}

export function messagesContainImages(messages: ShimMessage[]): boolean {
  for (const msg of messages) {
    const content = getContent(msg)
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (isImageBlock(block)) return true
      if (
        block?.type === 'tool_result' &&
        Array.isArray(block.content) &&
        block.content.some(isImageBlock)
      ) {
        return true
      }
    }
  }
  return false
}

function extractText(content: unknown, limit = 500): string {
  if (typeof content === 'string') return content.slice(0, limit)
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (b): b is Block =>
        !!b && typeof b === 'object' && (b as Block).type === 'text',
    )
    .map(b => String(b.text ?? ''))
    .join('\n')
    .slice(0, limit)
}

function buildDelegationPrompt(context: string): string {
  return (
    'You are the vision module of a coding assistant whose main model cannot ' +
    'see images. Analyze the attached image(s) so the assistant can act on ' +
    'your text alone. Transcribe ALL visible text verbatim (code, error ' +
    'messages, labels, numbers). Describe layout, UI elements, colors and ' +
    'anything relevant. Be precise and complete; do not speculate beyond ' +
    'what is visible.' +
    (context ? `\n\nContext for why the image was provided: ${context}` : '')
  )
}

// Analysis cache. History is resent on every turn, so the same image would
// otherwise trigger a fresh vision call each request.
const analysisCache = new Map<string, string>()
const inflight = new Map<string, Promise<string>>()
const ANALYSIS_CACHE_MAX = 50

function cacheAnalysis(key: string, value: string): void {
  if (analysisCache.size >= ANALYSIS_CACHE_MAX) {
    const oldest = analysisCache.keys().next().value
    if (oldest !== undefined) analysisCache.delete(oldest)
  }
  analysisCache.set(key, value)
}

/** Test hook. */
export function clearVisionAnalysisCache(): void {
  analysisCache.clear()
  inflight.clear()
}

async function analyzeGroup(
  group: ImageGroup,
  visionModel: string,
  callVision: VisionCaller,
): Promise<string> {
  const key = groupKey(group.images)
  const cached = analysisCache.get(key)
  if (cached !== undefined) return cached

  const pending = inflight.get(key)
  if (pending) return pending

  const task = (async () => {
    const analysis = await callVision({
      model: visionModel,
      images: group.images,
      prompt: buildDelegationPrompt(group.context),
    })
    cacheAnalysis(key, analysis)
    return analysis
  })()
  inflight.set(key, task)
  try {
    return await task
  } finally {
    inflight.delete(key)
  }
}

/**
 * Replace every image block in `messages` with the vision model's text
 * analysis. Returns the original array untouched when there is nothing to do.
 * A failed vision call degrades to a placeholder — it never throws, so the
 * main request always proceeds image-free.
 */
export async function delegateImagesInMessages(
  messages: ShimMessage[],
  visionModel: string,
  callVision: VisionCaller,
): Promise<ShimMessage[]> {
  if (!messagesContainImages(messages)) return messages

  // Map tool_use id -> tool name so tool_result images get a useful context.
  const toolNameById = new Map<string, string>()
  let lastUserText = ''
  for (const msg of messages) {
    const content = getContent(msg)
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === 'tool_use' && block.id && block.name) {
        toolNameById.set(String(block.id), String(block.name))
      }
    }
  }

  const analyzeAndFormat = async (group: ImageGroup): Promise<string> => {
    try {
      const analysis = await analyzeGroup(group, visionModel, callVision)
      return `${visionAnalysisMarker(visionModel)}\n${analysis}`
    } catch (error) {
      logForDebugging(
        `[VisionDelegate] vision call failed: ${(error as Error).message}`,
        { level: 'warn' },
      )
      return `[Image could not be analyzed: ${(error as Error).message?.slice(0, 120) ?? 'unknown error'}]`
    }
  }

  const rewriteBlocks = async (
    blocks: unknown[],
    context: string,
  ): Promise<unknown[]> => {
    const images = blocks.filter(isImageBlock)
    if (images.length === 0) return blocks
    const analysisText = await analyzeAndFormat({ images, context })
    let first = true
    return blocks.map(block => {
      if (!isImageBlock(block)) return block
      if (first) {
        first = false
        return { type: 'text', text: analysisText }
      }
      // Grouped images share one combined analysis (emitted above).
      return { type: 'text', text: '[See combined image analysis above]' }
    })
  }

  const result: ShimMessage[] = []
  for (const msg of messages) {
    const content = getContent(msg)
    if (typeof content === 'string' || !Array.isArray(content)) {
      if (msg.role === 'user' || msg.message?.role === 'user') {
        const text = extractText(content)
        if (text) lastUserText = text
      }
      result.push(msg)
      continue
    }

    const isUser = msg.role === 'user' || msg.message?.role === 'user'
    const userText = extractText(content)
    if (isUser && userText) lastUserText = userText

    let changed = false
    const newContent: unknown[] = []
    for (const block of content) {
      if (isImageBlock(block)) {
        // Handled at message level below (group all top-level images of this
        // message into one call). Placeholder for position; replaced next.
        newContent.push(block)
        changed = true
        continue
      }
      if (
        block?.type === 'tool_result' &&
        Array.isArray(block.content) &&
        block.content.some(isImageBlock)
      ) {
        const toolName = toolNameById.get(String(block.tool_use_id ?? ''))
        const context =
          `image returned by tool ${toolName ?? 'unknown'}` +
          (lastUserText ? `; user's request: ${lastUserText}` : '')
        newContent.push({
          ...block,
          content: await rewriteBlocks(block.content, context),
        })
        changed = true
        continue
      }
      newContent.push(block)
    }

    if (!changed) {
      result.push(msg)
      continue
    }

    // Rewrite the top-level image blocks (pasted images in user messages).
    const context = isUser
      ? userText
        ? `the user sent the image with this message: ${userText}`
        : 'image pasted by the user'
      : lastUserText
        ? `user's request: ${lastUserText}`
        : ''
    const finalContent = await rewriteBlocks(newContent, context)

    if (msg.message) {
      result.push({
        ...msg,
        message: { ...msg.message, content: finalContent },
      })
    } else {
      result.push({ ...msg, content: finalContent })
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Belt and suspenders: strip anything that survived to the OpenAI wire format
// ---------------------------------------------------------------------------

type OpenAIPart = { type: string; text?: string; image_url?: unknown }

/**
 * Final safety pass over converted OpenAI-format messages. If any image_url
 * part survived for a non-vision model, replace it with a text placeholder
 * (and log — it means a path escaped the delegation pre-pass). Mutates
 * nothing; returns a new array only when something was stripped.
 */
export function stripResidualImageParts(
  openaiMessages: Array<Record<string, unknown>>,
): { messages: Array<Record<string, unknown>>; removed: number } {
  let removed = 0
  const rewritten = openaiMessages.map(msg => {
    const content = msg.content
    if (!Array.isArray(content)) return msg
    if (!content.some(p => (p as OpenAIPart)?.type === 'image_url')) return msg
    removed += content.filter(
      p => (p as OpenAIPart)?.type === 'image_url',
    ).length
    const parts = content.map(p =>
      (p as OpenAIPart)?.type === 'image_url'
        ? { type: 'text', text: IMAGE_REMOVED_PLACEHOLDER }
        : p,
    )
    return { ...msg, content: parts }
  })
  if (removed > 0) {
    logForDebugging(
      `[VisionDelegate] stripped ${removed} residual image part(s) after conversion — a path escaped the pre-pass`,
      { level: 'warn' },
    )
    return { messages: rewritten, removed }
  }
  return { messages: openaiMessages, removed: 0 }
}
