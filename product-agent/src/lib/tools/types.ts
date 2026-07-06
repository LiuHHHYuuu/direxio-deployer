import type { FetchLike, GatewayChatRequest } from "../types.js";
import type { ThreadMemorySnapshot } from "../memory/thread-memory.js";

export interface AgentToolInvocation {
  name: string;
  input: Record<string, unknown>;
  reason: string;
  requiresContextAuthorization?: boolean;
}

export interface AgentToolResult {
  name: string;
  ok: boolean;
  content: string;
}

export interface AgentToolContext {
  event: Record<string, unknown>;
  payload: GatewayChatRequest;
  memory: ThreadMemorySnapshot;
  fetchImpl: FetchLike;
  env: NodeJS.ProcessEnv;
}

export interface AgentTool {
  name: string;
  description: string;
  run(input: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult>;
}
