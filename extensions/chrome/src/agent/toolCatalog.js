/**
 * OpenAI-style tool definitions for the standalone extension agent.
 *
 * The Browser Controller owns risk and validation. This adapter exposes the
 * same versioned catalog to the model but deliberately omits policy metadata
 * from model-produced calls.
 */

import {
  BROWSER_TOOL_CATALOG,
  TOOL_RISK_MAP,
} from '../controller/protocol.js'

export const OPENAI_TOOLS = BROWSER_TOOL_CATALOG.map((tool) => ({
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  },
}))

/**
 * Display-only risk lookup. execute() always reconstructs risk from the
 * controller catalog, so this helper cannot grant authority to a caller.
 *
 * @param {string} toolName
 * @returns {'read'|'mutate'|'elevated'}
 */
export function getToolRisk(toolName) {
  return TOOL_RISK_MAP[toolName] ?? 'elevated'
}

/**
 * Convert an LLM function call to raw controller input. Risk and the string
 * used for hard-block matching are intentionally absent.
 *
 * @param {{ id: string, name: string, arguments: string }} toolCall
 * @returns {{ id: string; name: string; params: Record<string, unknown> }}
 */
export function toToolCall(toolCall) {
  return {
    id: toolCall.id,
    name: toolCall.name,
    params: parseArguments(toolCall.arguments),
  }
}

/** @param {string} argStr */
function parseArguments(argStr) {
  try {
    const parsed = JSON.parse(argStr)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    return {}
  } catch {
    return {}
  }
}
