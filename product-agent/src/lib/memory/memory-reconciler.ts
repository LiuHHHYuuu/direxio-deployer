import type { MemoryCandidate } from "./memory-candidate.js";
import type { AgentMemoryItem, ThreadMemoryStore } from "./thread-memory.js";

export type MemoryChangeAction = "created" | "updated" | "deleted" | "noop";

export interface MemoryChange {
  action: MemoryChangeAction;
  key: string;
  memoryId?: string;
}

/** Reconciles an approved candidate against the canonical `(scope, key)` memory slot. */
export function reconcileMemoryCandidate({
  store,
  conversationId,
  candidate
}: {
  store: ThreadMemoryStore;
  conversationId: string;
  candidate: MemoryCandidate;
}): MemoryChange {
  const existing = canonicalMemory(store.listMemories(conversationId), candidate);
  if (candidate.operation === "delete") {
    if (!existing) return { action: "noop", key: candidate.key };
    const deleted = store.deleteMemory(conversationId, existing.id);
    return { action: deleted ? "deleted" : "noop", key: candidate.key, memoryId: existing.id };
  }
  if (existing && equivalentText(existing.text, candidate.text)) {
    return { action: "noop", key: candidate.key, memoryId: existing.id };
  }
  const saved = store.saveMemory(conversationId, {
    ...(existing ? { id: existing.id } : {}),
    key: candidate.key,
    scope: candidate.scope,
    type: candidate.type,
    text: candidate.text,
    tags: [candidate.type, `memory_key:${candidate.key}`, `scope:${candidate.scope}`],
    source: "automatic_extraction",
    confidence: candidate.confidence,
    importance: candidate.importance,
    sensitivity: candidate.sensitivity,
    evidence: candidate.evidence
  });
  return {
    action: existing ? "updated" : "created",
    key: candidate.key,
    memoryId: saved.id
  };
}

function canonicalMemory(items: AgentMemoryItem[], candidate: MemoryCandidate): AgentMemoryItem | undefined {
  return items.find((item) => item.key === candidate.key && (item.scope || "conversation") === candidate.scope);
}

function equivalentText(left: string, right: string): boolean {
  return left.trim().toLowerCase().replace(/\s+/g, " ") === right.trim().toLowerCase().replace(/\s+/g, " ");
}
