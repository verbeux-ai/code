import { execute } from './execute.js'

/**
 * Build the single approval-aware executor used by every browser-tool caller.
 * The injected dependency keeps the approval state machine independently
 * testable while the production export always uses the policy-gated execute().
 *
 * @param {typeof execute} executeTool
 */
export function createApprovalExecutor(executeTool) {
  return async function executeWithApproval(rawToolCall, contextFactory, approvalUi) {
    const first = await executeTool(rawToolCall, await contextFactory())
    if (!first.policy?.needsApproval || !first.toolCall) {
      if (!first.ok && first.toolCall) {
        approvalUi.onPolicyDenied?.({
          toolCall: first.toolCall,
          policy: first.policy,
        })
      }
      return first
    }

    const decision = await approvalUi.request({
      toolCall: first.toolCall,
      policy: first.policy,
    })
    await approvalUi.onApprovalClosed?.({
      toolCall: first.toolCall,
      decision,
    })

    if (decision === 'deny' || decision === 'cancelled' || decision === 'timeout') {
      return {
        ok: false,
        error: decision === 'deny' ? 'denied_by_user' : decision,
        policy: first.policy,
        toolCall: first.toolCall,
      }
    }

    if (decision !== 'once' && decision !== 'always') {
      return {
        ok: false,
        error: 'invalid_approval_decision',
        policy: first.policy,
        toolCall: first.toolCall,
      }
    }

    const context = await contextFactory()
    if (decision === 'always') {
      if (!first.policyHost || typeof context.setSiteGrant !== 'function') {
        return {
          ok: false,
          error: 'persistent_grant_unavailable',
          policy: first.policy,
          toolCall: first.toolCall,
        }
      }
      await context.setSiteGrant(first.policyHost, 'always')
    }
    return executeTool(first.toolCall, {
      ...context,
      approvedTool: {
        id: first.toolCall.id,
        input: first.toolCall.input,
      },
    })
  }
}

export const executeWithApproval = createApprovalExecutor(execute)
