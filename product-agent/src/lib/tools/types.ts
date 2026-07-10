import type { FetchLike, GatewayChatRequest } from "../types.js";
import type { ThreadMemorySnapshot, ThreadMemoryStore } from "../memory/thread-memory.js";

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
  sources?: string[];
}

export type AgentToolPermissionScope =
  | "current_ai_thread"
  | "thread_memory"
  | "contacts"
  | "public_web"
  | "explicit_selected_context";

export interface AgentToolPermission {
  scope: AgentToolPermissionScope;
  access: "read" | "write";
  required: boolean;
}

export interface AgentToolManifest {
  schema: "direxio.agent_tool.v1";
  name: string;
  title: string;
  description: string;
  category: "thread" | "memory" | "contacts" | "web" | "experience";
  source?: "official" | "user" | "mcp" | "developer";
  skillKind?: "built_in" | "prompt" | "mcp" | "http";
  defaultEnabled: boolean;
  permissions: AgentToolPermission[];
  inputSchema?: Record<string, unknown>;
  outputKind: "text" | "agent_action_result";
  triggerExamples?: string[];
  shareable?: boolean;
  capabilities?: string[];
  produces?: string[];
}

export interface AgentToolContext {
  event: Record<string, unknown>;
  payload: GatewayChatRequest;
  memory: ThreadMemorySnapshot;
  memoryStore?: ThreadMemoryStore;
  fetchImpl: FetchLike;
  env: NodeJS.ProcessEnv;
  gatewayUrl?: string;
  aiToken?: string;
}

export interface AgentTool {
  name: string;
  description: string;
  manifest: AgentToolManifest;
  run(input: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult>;
}
