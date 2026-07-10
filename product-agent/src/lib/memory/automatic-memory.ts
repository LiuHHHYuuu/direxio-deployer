import type { FetchLike, GatewayMessage } from "../types.js";
import type { MemoryCandidateExtractor } from "./memory-extractor.js";
import { evaluateMemoryCandidate, isExplicitMemoryInstruction } from "./memory-policy.js";
import { reconcileMemoryCandidate, type MemoryChange } from "./memory-reconciler.js";
import type { ThreadMemoryStore } from "./thread-memory.js";

export interface AutomaticMemoryOptions {
  extractor: MemoryCandidateExtractor;
  store: ThreadMemoryStore;
  nodeId: string;
  conversationId: string;
  model: string;
  latestUserMessage: string;
  assistantReply: string;
  recentMessages: GatewayMessage[];
  gatewayUrl: string;
  aiToken: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
  maxCandidates: number;
  minConfidence: number;
  minImportance: number;
}

/** Runs best-effort automatic memory extraction without affecting the chat result. */
export async function runAutomaticMemory(options: AutomaticMemoryOptions): Promise<MemoryChange[]> {
  if (!options.latestUserMessage.trim()) return [];
  const currentMemories = options.store.listMemories(options.conversationId);
  const candidates = await options.extractor.extract({
    nodeId: options.nodeId,
    conversationId: options.conversationId,
    model: options.model,
    latestUserMessage: options.latestUserMessage,
    assistantReply: options.assistantReply,
    recentMessages: options.recentMessages,
    currentMemories,
    gatewayUrl: options.gatewayUrl,
    aiToken: options.aiToken,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    maxCandidates: options.maxCandidates
  });
  const explicitRequest = isExplicitMemoryInstruction(options.latestUserMessage);
  const changes: MemoryChange[] = [];
  for (const candidate of candidates.slice(0, options.maxCandidates)) {
    const decision = evaluateMemoryCandidate(candidate, {
      latestUserMessage: options.latestUserMessage,
      explicitRequest
    }, {
      minConfidence: options.minConfidence,
      minImportance: options.minImportance
    });
    if (!decision.accepted) continue;
    changes.push(reconcileMemoryCandidate({
      store: options.store,
      conversationId: options.conversationId,
      candidate: decision.candidate
    }));
  }
  return changes;
}
