import type { AgentActionName } from "./types.js";

export interface AgentActionRequest {
  type: "agent_action";
  action: AgentActionName;
  focus?: string;
  limit?: number;
}

const ACTION_TOOL_NAMES: Record<AgentActionName, string> = {
  persona_card: "create_persona_card",
  memory_capsule: "create_memory_capsule",
  mood_card: "create_mood_card"
};

export function isAgentActionName(value: unknown): value is AgentActionName {
  return value === "persona_card" || value === "memory_capsule" || value === "mood_card";
}

export function toolNameForAgentAction(action: AgentActionName): string {
  return ACTION_TOOL_NAMES[action];
}

export function parseAgentActionContent(content: string): AgentActionRequest | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return normalizeAgentAction(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

export function normalizeAgentAction(value: unknown): AgentActionRequest | null {
  const record = asRecord(value);
  if (record.type !== "agent_action" || !isAgentActionName(record.action)) return null;
  return {
    type: "agent_action",
    action: record.action,
    ...(typeof record.focus === "string" && record.focus.trim() ? { focus: record.focus.trim() } : {}),
    ...(typeof record.limit === "number" && Number.isFinite(record.limit) ? { limit: Math.floor(record.limit) } : {})
  };
}

export function agentActionToMessageContent(action: AgentActionRequest): string {
  return JSON.stringify({
    type: "agent_action",
    action: action.action,
    ...(action.focus ? { focus: action.focus } : {}),
    ...(typeof action.limit === "number" ? { limit: action.limit } : {})
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}
