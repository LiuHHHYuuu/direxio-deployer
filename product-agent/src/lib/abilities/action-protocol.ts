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

const ACTION_TEXT_ALIASES: Record<string, AgentActionName> = {
  persona: "persona_card",
  "persona card": "persona_card",
  "digital persona card": "persona_card",
  "\u6570\u5b57\u4eba\u683c\u5361": "persona_card",
  "\u30c7\u30b8\u30bf\u30eb\u4eba\u683c\u30ab\u30fc\u30c9": "persona_card",
  memory: "memory_capsule",
  "memory capsule": "memory_capsule",
  "\u8bb0\u5fc6\u80f6\u56ca": "memory_capsule",
  "\u8a18\u61b6\u30ab\u30d7\u30bb\u30eb": "memory_capsule",
  mood: "mood_card",
  "mood card": "mood_card",
  "\u4eca\u65e5\u72b6\u6001\u5361": "mood_card",
  "\u4eca\u65e5\u306e\u72b6\u614b\u30ab\u30fc\u30c9": "mood_card"
};

export function isAgentActionName(value: unknown): value is AgentActionName {
  return value === "persona_card" || value === "memory_capsule" || value === "mood_card";
}

export function toolNameForAgentAction(action: AgentActionName): string {
  return ACTION_TOOL_NAMES[action];
}

export function parseAgentActionContent(content: string): AgentActionRequest | null {
  const trimmed = content.trim();
  const aliasedAction = actionNameFromHumanText(trimmed);
  if (aliasedAction) {
    return {
      type: "agent_action",
      action: aliasedAction
    };
  }
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

function actionNameFromHumanText(value: string): AgentActionName | null {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return ACTION_TEXT_ALIASES[normalized] || null;
}
