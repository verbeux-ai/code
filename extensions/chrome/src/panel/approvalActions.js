import { MSG } from '../controller/protocol.js'

export function approvalMessage(toolCallId, decision) {
  if (decision !== 'once' && decision !== 'always') {
    throw new Error('invalid_approval_decision')
  }
  return {
    type: MSG.TOOL_APPROVE,
    toolCallId,
    decision,
  }
}
