import { callHostedGateway } from "../hosted-gateway-client.js";
import type { FetchLike, GatewayMessage } from "../types.js";
import { parseMemoryCandidates, type MemoryCandidate } from "./memory-candidate.js";
import type { AgentMemoryItem } from "./thread-memory.js";

export interface MemoryExtractionInput {
  nodeId: string;
  conversationId: string;
  model: string;
  latestUserMessage: string;
  assistantReply: string;
  recentMessages: GatewayMessage[];
  currentMemories: AgentMemoryItem[];
  gatewayUrl: string;
  aiToken: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
  maxCandidates: number;
}

export interface MemoryCandidateExtractor {
  extract(input: MemoryExtractionInput): Promise<MemoryCandidate[]>;
}

export class GatewayMemoryCandidateExtractor implements MemoryCandidateExtractor {
  async extract(input: MemoryExtractionInput): Promise<MemoryCandidate[]> {
    const result = await callHostedGateway({
      gatewayUrl: input.gatewayUrl,
      aiToken: input.aiToken,
      fetchImpl: input.fetchImpl,
      timeoutMs: input.timeoutMs,
      payload: {
        node_id: input.nodeId,
        conversation_id: input.conversationId,
        task: "memory_extract",
        model: input.model,
        messages: [
          { role: "system", content: MEMORY_EXTRACTION_PROMPT },
          { role: "user", content: JSON.stringify(extractionContext(input)) }
        ],
        tool_choice: "none"
      }
    });
    return result.ok ? parseMemoryCandidates(result.reply, input.maxCandidates) : [];
  }
}

function extractionContext(input: MemoryExtractionInput): Record<string, unknown> {
  return {
    latest_user_message: input.latestUserMessage,
    assistant_reply: input.assistantReply,
    recent_agent_thread: input.recentMessages.slice(-6).map((message) => ({
      role: message.role,
      content: message.content.slice(0, 600)
    })),
    current_memories: input.currentMemories
      .filter((item) => item.key)
      .slice(-12)
      .map((item) => ({ key: item.key, text: item.text, scope: item.scope || "conversation" }))
  };
}

const MEMORY_EXTRACTION_PROMPT = [
  "Extract only durable user memory directly supported by the latest user message.",
  "Return JSON only: {\"candidates\":[...]}. Return an empty candidates array when nothing is worth remembering.",
  "Each candidate must contain operation, key, text, type, scope, confidence, importance, sensitivity, evidence, and reason.",
  "Allowed operations: create, update, delete, noop. Allowed types: fact, preference. Allowed scopes: owner, conversation.",
  "Use stable dotted keys such as profile.location.city, preference.response.length, goal.current, or project.<name>.goal.",
  "Use owner scope for durable user facts/preferences/goals; conversation scope only for thread-specific facts.",
  "Evidence must be an exact short quote from the latest user message.",
  "Do not infer residence from a weather query or a mentioned city. Do not save temporary states or third-party facts.",
  "Mark credentials as secret and health, finance, politics, religion, sexuality, exact address, and identifiers as sensitive.",
  "Use update when a current memory with the same key changed, and delete only when the user asks to forget that key."
].join("\n");
