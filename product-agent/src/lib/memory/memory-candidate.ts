import type {
  AgentMemoryItemType,
  AgentMemoryScope,
  AgentMemorySensitivity
} from "./thread-memory.js";

export type MemoryCandidateOperation = "create" | "update" | "delete" | "noop";

export interface MemoryCandidate {
  operation: MemoryCandidateOperation;
  key: string;
  text: string;
  type: Extract<AgentMemoryItemType, "preference" | "fact">;
  scope: AgentMemoryScope;
  confidence: number;
  importance: number;
  sensitivity: AgentMemorySensitivity;
  evidence: string;
  reason: string;
}

/** Parses the model's untrusted JSON response into bounded memory candidates. */
export function parseMemoryCandidates(raw: string, maxCandidates = 3): MemoryCandidate[] {
  const parsed = parseJson(raw);
  const record = asRecord(parsed);
  const values = Array.isArray(parsed)
    ? parsed
    : Array.isArray(record.candidates)
      ? record.candidates
      : [];
  return values
    .map(normalizeMemoryCandidate)
    .filter((candidate): candidate is MemoryCandidate => Boolean(candidate))
    .slice(0, Math.max(1, Math.min(10, Math.floor(maxCandidates))));
}

function normalizeMemoryCandidate(value: unknown): MemoryCandidate | null {
  const record = asRecord(value);
  const operation = memoryOperation(record.operation);
  const key = boundedString(record.key, 120).toLowerCase();
  const text = boundedString(record.text, 600);
  const type = record.type === "preference" ? "preference" : record.type === "fact" ? "fact" : null;
  const scope = record.scope === "conversation" ? "conversation" : record.scope === "owner" ? "owner" : null;
  const sensitivity = memorySensitivity(record.sensitivity);
  const evidence = boundedString(record.evidence, 500);
  const reason = boundedString(record.reason, 500);
  if (!operation || !key || !type || !scope || !sensitivity) return null;
  if (operation !== "delete" && operation !== "noop" && !text) return null;
  return {
    operation,
    key,
    text,
    type,
    scope,
    confidence: boundedScore(record.confidence),
    importance: boundedScore(record.importance),
    sensitivity,
    evidence,
    reason
  };
}

function parseJson(raw: string): unknown {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return {};
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(withoutFence);
  } catch {
    const start = Math.min(
      ...[withoutFence.indexOf("{"), withoutFence.indexOf("[")].filter((index) => index >= 0)
    );
    const objectEnd = withoutFence.lastIndexOf("}");
    const arrayEnd = withoutFence.lastIndexOf("]");
    const end = Math.max(objectEnd, arrayEnd);
    if (!Number.isFinite(start) || start < 0 || end <= start) return {};
    try {
      return JSON.parse(withoutFence.slice(start, end + 1));
    } catch {
      return {};
    }
  }
}

function memoryOperation(value: unknown): MemoryCandidateOperation | null {
  return value === "create" || value === "update" || value === "delete" || value === "noop"
    ? value
    : null;
}

function memorySensitivity(value: unknown): AgentMemorySensitivity | null {
  if (value === "low" || value === "sensitive" || value === "secret") return value;
  if (value === "normal" || value === "non-sensitive" || value === "nonsensitive") return "low";
  return null;
}

function boundedScore(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0;
}

function boundedString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}
