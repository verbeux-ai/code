/**
 * execute.js — Browser Controller entry point.
 *
 * Contract: EVERY tool call passes through evaluateToolPolicy before
 * any chrome.* API is touched. If policy denies, the tool never runs
 * and the denial is returned to the caller (agent client / panel).
 *
 * The controller is the single chokepoint the design spec §6.2 calls
 * "Browser Controller boundary". Clients cannot bypass it.
 *
 * @typedef {import('../policy/evaluateToolPolicy.js').PolicyDecision} PolicyDecision
 * @typedef {import('../policy/evaluateToolPolicy.js').ChromePermissionMode} ChromePermissionMode
 * @typedef {import('../policy/evaluateToolPolicy.js').GrantDecision} GrantDecision
 * @typedef {import('../policy/evaluateToolPolicy.js').ToolCall} ToolCall
 *
 * @typedef {{
 *   mode: ChromePermissionMode;
 *   getSiteGrant: (host: string) => Promise<GrantDecision | undefined>;
 *   setSiteGrant: (host: string, decision: GrantDecision) => Promise<void>;
 *   activeTabId?: number;
 *   approvedTool?: { id: string; input: string };
 *   onExecuting?: (toolCall: ToolCall) => void | Promise<void>;
 * }} ExecutionContext
 *
 * @typedef {{ ok: true; result: unknown; policy: PolicyDecision } | { ok: false; error: string; policy: PolicyDecision }} ExecutionResult
 */

import { evaluateToolPolicy } from '../policy/evaluateToolPolicy.js'
import { canonicalizeToolCall } from './protocol.js'
import { navigate } from './tools/navigate.js'
import { readPage } from './tools/readPage.js'
import { findTool } from './tools/find.js'
import { extractPageContent } from './tools/extractPageContent.js'
import { structuredExtract } from './tools/structuredExtract.js'
import { click } from './tools/click.js'
import { typeText } from './tools/type.js'
import { screenshot } from './tools/screenshot.js'
import { tabs } from './tools/tabs.js'
import { tabGroup } from './tools/tabGroup.js'
import { consoleReader } from './tools/consoleReader.js'
import { networkReader } from './tools/networkReader.js'
import { fileUpload } from './tools/fileUpload.js'
import { gifRecording } from './tools/gifRecording.js'

/**
 * Execute a Browser Tool call after policy gate.
 *
 * @param {ToolCall} toolCall — { name, risk, input, ...args }
 * @param {ExecutionContext} ctx
 * @returns {Promise<ExecutionResult>}
 */
export async function execute(toolCall, ctx) {
  const canonical = canonicalizeToolCall(toolCall)
  if (!canonical.ok) {
    const reason = canonical.error === 'unknown_tool' ? 'unknown_tool' : 'invalid_tool_call'
    return {
      ok: false,
      error: canonical.error,
      policy: { allowed: false, needsApproval: false, reason },
      toolCall: null,
    }
  }
  const normalizedToolCall = canonical.toolCall

  // Navigation and new-tab grants belong to their destination. Other tools
  // inherit the active tab host.
  let siteGrant = undefined
  let policyHost = canonical.policyHost || ''
  if (ctx.getSiteGrant) {
    try {
      const host = policyHost || (
        ctx.activeTabId != null ? await getActiveTabHost(ctx.activeTabId) : ''
      )
      policyHost = host
      if (host) siteGrant = await ctx.getSiteGrant(host)
    } catch {
      // Non-fatal: treat as no grant.
    }
  }

  let policy = evaluateToolPolicy(ctx.mode, siteGrant, normalizedToolCall)

  // A one-shot approval is created only by approvedExecute.js after the user
  // approved this exact canonical id+input pair. It cannot override hard
  // blocks, site denials, validation failures, or a different call.
  if (
    policy.needsApproval &&
    ctx.approvedTool?.id === normalizedToolCall.id &&
    ctx.approvedTool?.input === normalizedToolCall.input
  ) {
    policy = { allowed: true, needsApproval: false, reason: 'approved_once' }
  }

  // Hard denials (allowed=false, needsApproval=false) never run.
  // needsApproval=true is returned to the caller — the controller does
  // not prompt the user directly; the panel/agent client handles it.
  if (!policy.allowed) {
    return { ok: false, error: policy.reason, policy, toolCall: normalizedToolCall, policyHost }
  }

  // Dispatch to the tool implementation.
  try {
    await ctx.onExecuting?.(normalizedToolCall)
    const result = await dispatch(normalizedToolCall, ctx)
    return { ok: true, result, policy, toolCall: normalizedToolCall, policyHost }
  } catch (err) {
    return {
      ok: false,
      error: err?.message ?? String(err),
      policy,
      toolCall: normalizedToolCall,
      policyHost,
    }
  }
}

/**
 * Dispatch a policy-approved toolCall to its implementation.
 * @param {ToolCall} toolCall
 * @param {ExecutionContext} ctx
 * @returns {Promise<unknown>}
 */
async function dispatch(toolCall, ctx) {
  // Flatten `params` onto the top level so tool handlers can read
  // `tool.url`, `tool.selector`, `tool.text` directly regardless of
  // whether the planner stored them under `toolCall.params`. Top-level
  // fields win when both are set (planner-sourced values are the
  // source of truth).
  const args = mergeToolArgs(toolCall)
  switch (args.name) {
    case 'navigate':
      return navigate(args)
    case 'read_page':
      return readPage(args, ctx)
    case 'find':
      return findTool(args, ctx)
    case 'extract_page_content':
      return extractPageContent(args, ctx)
    case 'structured_extract':
      return structuredExtract(args, ctx)
    case 'click':
      return click(args)
    case 'type':
      return typeText(args)
    case 'screenshot':
      // Pass activeTabId so capture targets the tab the agent is driving
      // (service workers have no reliable "current window").
      return screenshot(args, ctx)
    case 'tabs':
      return tabs(args)
    case 'tab_group':
      return tabGroup(args)
    case 'console_reader':
      return consoleReader(args)
    case 'console_clear':
      return consoleReader({ ...args, name: 'console_reader', action: 'clear' })
    case 'network_reader':
      return networkReader(args)
    case 'file_upload':
      return fileUpload(args)
    case 'gif_recording':
      return gifRecording(args)
    case 'console':
      return consoleReader(args)
    case 'network':
      return networkReader(args)
    case 'upload':
      return fileUpload(args)
    case 'gif_record':
      return gifRecording(args)
    default:
      throw new Error(`unknown_tool:${args.name}`)
  }
}

/**
 * Flatten a toolCall's `params` onto the top level. Top-level fields
 * win when both are present, so planner-sourced values (e.g.
 * `toolCall.url` set explicitly) override any value that happens to
 * also live in `toolCall.params`.
 *
 * @param {ToolCall} toolCall
 * @returns {Record<string, unknown>}
 */
export function mergeToolArgs(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return toolCall
  const { params, ...rest } = toolCall
  if (!params || typeof params !== 'object') return toolCall
  return { ...params, ...rest }
}

/**
 * Resolve the host of the active tab. Returns '' for internal pages.
 * @param {number} tabId
 * @returns {Promise<string>}
 */
async function getActiveTabHost(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (!tab?.url) return ''
    try {
      return new URL(tab.url).host
    } catch {
      return ''
    }
  } catch {
    return ''
  }
}
