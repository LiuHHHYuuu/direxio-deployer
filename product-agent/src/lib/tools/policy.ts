import type { AgentToolInvocation } from "./types.js";

export interface ToolPolicyDecision {
  allowed: boolean;
  reason?: string;
}

export function authorizeToolInvocation(
  invocation: AgentToolInvocation,
  event: Record<string, unknown>
): ToolPolicyDecision {
  if (invocation.requiresContextAuthorization && event.context_authorized !== true) {
    return {
      allowed: false,
      reason: "context_not_authorized"
    };
  }
  return { allowed: true };
}
