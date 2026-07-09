import type { AgentToolResult } from "./types.js";

const AGENT_ACTION_RESULT_SCHEMA = "direxio.agent_action_result.v1";

export function agentActionResultContentFromToolResults(results: AgentToolResult[]): string {
  for (const result of [...results].reverse()) {
    const content = agentActionResultContentFromText(result.content);
    if (content) return content;
  }
  return "";
}

export function agentActionResultContentFromText(value: string): string {
  const parsed = parseJsonRecord(value);
  if (parsed.schema !== AGENT_ACTION_RESULT_SCHEMA) return "";
  return JSON.stringify(parsed);
}

export function agentActionResultSummaryFromText(value: string): string {
  const parsed = parseJsonRecord(value);
  if (parsed.schema !== AGENT_ACTION_RESULT_SCHEMA) return "";
  return stringField(parsed.summary) || stringField(parsed.title);
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
  return typeof value === "string" ? value.trim() : "";
}
