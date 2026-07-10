import type { AgentActionResult, AgentActionName } from "../abilities/types.js";
import { redactCredentialLikeSecrets } from "../memory/memory-safety.js";
import type { ThreadMemorySnapshot } from "../memory/thread-memory.js";
import { callHostedGateway } from "../hosted-gateway-client.js";
import type { CardState } from "../runtime/card-planner.js";
import type { FetchLike, GatewayMessage } from "../types.js";

export interface CardGenerationSkillInput {
  action: AgentActionName;
  state: CardState;
  focus?: string;
  messages: GatewayMessage[];
  memory: ThreadMemorySnapshot;
  nodeId: string;
  conversationId: string;
  model: string;
  gatewayUrl: string;
  aiToken: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
}

export type CardGenerationSkillResult =
  | { ok: true; card: AgentActionResult }
  | { ok: false; reason: string };

export interface CardGenerationSkill {
  generate(input: CardGenerationSkillInput): Promise<CardGenerationSkillResult>;
}

export class GatewayCardGenerationSkill implements CardGenerationSkill {
  async generate(input: CardGenerationSkillInput): Promise<CardGenerationSkillResult> {
    const result = await callHostedGateway({
      gatewayUrl: input.gatewayUrl,
      aiToken: input.aiToken,
      fetchImpl: input.fetchImpl,
      timeoutMs: input.timeoutMs,
      payload: {
        node_id: input.nodeId,
        conversation_id: input.conversationId,
        task: "card_generation",
        model: input.model,
        messages: [
          { role: "system", content: cardSkillInstruction(input.action, input.state) },
          { role: "user", content: cardSkillContext(input) }
        ],
        tool_choice: "none"
      }
    });
    if (!result.ok) return { ok: false, reason: result.error.code };
    const card = parseGeneratedCard(result.reply, input.action);
    return card ? { ok: true, card } : { ok: false, reason: "invalid_card_output" };
  }
}

export function parseGeneratedCard(value: string, expectedAction: AgentActionName): AgentActionResult | null {
  const record = parseJsonObject(value);
  if (record.action !== expectedAction) return null;
  const title = boundedString(record.title, 32);
  const summary = boundedString(record.summary, 100);
  const points = stringList(record.points, 3, 56);
  const nextActions = stringList(record.nextActions, 2, 32);
  if (!title || !summary || points.length === 0) return null;
  return {
    schema: "direxio.agent_action_result.v1",
    action: expectedAction,
    title,
    summary,
    points,
    nextActions,
    privacy: {
      sourceScope: "current_ai_thread",
      defaultVisibility: "private",
      shareRequiresUserAction: true
    }
  };
}

function cardSkillInstruction(action: AgentActionName, state: CardState): string {
  return [
    "You are the built-in Direxio Adaptive Card Skill.",
    `Create exactly one ${action} card for state ${state}.`,
    "Use only evidence in the supplied current-thread context and approved memories.",
    "Do not diagnose mental health, exaggerate emotion, invent facts, or expose credentials.",
    "Use the user's language. Make the card specific, warm, compact, and useful.",
    "Return JSON only with keys: action, title, summary, points, nextActions.",
    `action must be exactly ${action}.`,
    "title <= 32 chars; summary <= 100 chars; points has 1-3 short strings; nextActions has 0-2 short strings.",
    "Do not include schema, privacy, markdown fences, commentary, or raw context."
  ].join("\n");
}

function cardSkillContext(input: CardGenerationSkillInput): string {
  const recentMessages = input.messages.slice(-10).map((message) => ({
    role: message.role,
    content: redactCredentialLikeSecrets(message.content).slice(0, 320)
  }));
  const memories = [
    ...(input.memory.relevantMemories || []),
    ...input.memory.persistentMemories
  ]
    .filter((item) => !item.deletedAt && item.sensitivity !== "secret")
    .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
    .slice(0, 6)
    .map((item) => ({ key: item.key || item.type, text: redactCredentialLikeSecrets(item.text).slice(0, 240) }));
  return JSON.stringify({
    focus: input.focus || "",
    inferredState: input.state,
    preferences: input.memory.preferences,
    approvedMemories: memories,
    recentMessages
  });
}

function parseJsonObject(value: string): Record<string, unknown> {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const candidate = trimmed.startsWith("{") ? trimmed : trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function boundedString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maxLength) : "";
}

function stringList(value: unknown, maxItems: number, maxLength: number): string[] {
  return Array.isArray(value)
    ? value.map((item) => boundedString(item, maxLength)).filter(Boolean).slice(0, maxItems)
    : [];
}
