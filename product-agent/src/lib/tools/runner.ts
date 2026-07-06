import type { FetchLike, GatewayChatRequest, GatewayMessage } from "../types.js";
import type { ThreadMemorySnapshot } from "../memory/thread-memory.js";
import { parseAgentActionContent, toolNameForAgentAction } from "../abilities/action-protocol.js";
import { authorizeToolInvocation } from "./policy.js";
import type { AgentTool, AgentToolContext, AgentToolInvocation, AgentToolResult } from "./types.js";

export interface AgentToolRunOptions {
  event: Record<string, unknown>;
  payload: GatewayChatRequest;
  memory: ThreadMemorySnapshot;
  tools: AgentTool[];
  fetchImpl: FetchLike;
  env: NodeJS.ProcessEnv;
}

export async function runSelectedAgentTools(options: AgentToolRunOptions): Promise<AgentToolResult[]> {
  const invocations = selectToolInvocations(options.payload);
  const toolsByName = new Map(options.tools.map((tool) => [tool.name, tool]));
  const context: AgentToolContext = {
    event: options.event,
    payload: options.payload,
    memory: options.memory,
    fetchImpl: options.fetchImpl,
    env: options.env
  };
  const results: AgentToolResult[] = [];

  for (const invocation of invocations) {
    const tool = toolsByName.get(invocation.name);
    if (!tool) continue;
    const decision = authorizeToolInvocation(invocation, options.event);
    if (!decision.allowed) {
      results.push({
        name: invocation.name,
        ok: false,
        content: `Tool blocked by policy: ${decision.reason || "not_allowed"}.`
      });
      continue;
    }
    try {
      results.push(await tool.run(invocation.input, context));
    } catch (error) {
      results.push({
        name: invocation.name,
        ok: false,
        content: error instanceof Error ? error.message : "Tool failed."
      });
    }
  }

  return results;
}

export function toolResultsAsSystemMessage(results: AgentToolResult[]): GatewayMessage | null {
  if (results.length === 0) return null;
  return {
    role: "system",
    content: [
      "Direxio local tool context:",
      ...results.map((result) => `- ${result.name} (${result.ok ? "ok" : "error"}):\n${formatToolResultContent(result.content)}`)
    ].join("\n")
  };
}

export function memoryAsSystemMessage(memory: ThreadMemorySnapshot): GatewayMessage | null {
  const preferences = Object.entries(memory.preferences);
  if (preferences.length === 0) return null;
  return {
    role: "system",
    content: [
      "Direxio thread memory:",
      ...preferences.map(([key, value]) => `- ${key}: ${value}`)
    ].join("\n")
  };
}

function selectToolInvocations(payload: GatewayChatRequest): AgentToolInvocation[] {
  const latestUser = [...payload.messages].reverse().find((message) => message.role === "user");
  const text = latestUser?.content || "";
  const normalized = text.toLowerCase();
  const invocations: AgentToolInvocation[] = [];
  const action = parseAgentActionContent(text);

  if (action) {
    invocations.push({
      name: toolNameForAgentAction(action.action),
      input: { focus: action.focus || "", limit: action.limit || 8 },
      reason: "user_selected_agent_action"
    });
    return dedupeInvocations(invocations);
  }

  if (containsAny(normalized, ["最近", "recent", "history", "上下文"])) {
    invocations.push({
      name: "list_recent_ai_messages",
      input: { limit: 8 },
      reason: "user_asked_for_recent_thread_context"
    });
  }

  if (containsAny(normalized, ["搜索", "search", "find"])) {
    const query = extractSearchQuery(text);
    invocations.push({
      name: "search_current_ai_thread",
      input: { query },
      reason: "user_asked_to_search_current_thread"
    });
  }

  if (containsAny(normalized, ["联系人", "contacts", "好友"])) {
    invocations.push({
      name: "list_contacts",
      input: {},
      reason: "user_asked_for_contacts"
    });
  }

  if (containsAny(normalized, ["我喜欢什么", "偏好", "preference", "remembered"])) {
    invocations.push({
      name: "get_thread_memory",
      input: {},
      reason: "user_asked_for_thread_memory"
    });
  }

  if (containsAny(normalized, ["联网", "网页", "web search", "internet", "最新"])) {
    invocations.push({
      name: "web_search",
      input: { query: text },
      reason: "user_asked_for_public_web_search"
    });
  }

  if (containsAny(normalized, ["persona card", "digital persona", "profile card", "personality card"])) {
    invocations.push({
      name: "create_persona_card",
      input: { focus: extractExperienceFocus(text), limit: 12 },
      reason: "user_asked_for_persona_card"
    });
  }

  if (containsAny(normalized, ["memory capsule", "thread recap", "weekly recap", "recap card"])) {
    invocations.push({
      name: "create_memory_capsule",
      input: { focus: extractExperienceFocus(text), limit: 12 },
      reason: "user_asked_for_memory_capsule"
    });
  }

  if (containsAny(normalized, ["mood card", "status card", "mood snapshot"])) {
    invocations.push({
      name: "create_mood_card",
      input: { focus: extractExperienceFocus(text), limit: 12 },
      reason: "user_asked_for_mood_card"
    });
  }

  return dedupeInvocations(invocations);
}

function extractSearchQuery(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/(?:搜索|search|find)\s*[:：]?\s*(.+)$/i);
  return match?.[1]?.trim() || trimmed;
}

function extractExperienceFocus(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/(?:persona card|digital persona|profile card|memory capsule|thread recap|weekly recap|recap card|mood card|status card|mood snapshot)\s*[:-]?\s*(.*)$/i);
  return match?.[1]?.trim() || "";
}

function formatToolResultContent(content: string): string {
  const parsed = parseJsonRecord(content);
  if (parsed.schema !== "direxio.agent_action_result.v1") return content;
  const points = Array.isArray(parsed.points)
    ? parsed.points.filter((point): point is string => typeof point === "string").slice(0, 3)
    : [];
  const nextActions = Array.isArray(parsed.nextActions)
    ? parsed.nextActions.filter((action): action is string => typeof action === "string").slice(0, 1)
    : [];
  return [
    stringField(parsed.title),
    stringField(parsed.summary),
    ...points.map((point) => `- ${point}`),
    ...nextActions.map((action) => `Next: ${action}`)
  ].filter(Boolean).join("\n");
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function containsAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function dedupeInvocations(invocations: AgentToolInvocation[]): AgentToolInvocation[] {
  const seen = new Set<string>();
  return invocations.filter((invocation) => {
    if (seen.has(invocation.name)) return false;
    seen.add(invocation.name);
    return true;
  });
}
