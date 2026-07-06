export type ChatRole = "user" | "assistant" | "system" | "tool";

export interface GatewayToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  type: "tool_call";
}

export interface GatewayMessage {
  role: ChatRole;
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: GatewayToolCall[];
}

export interface GatewayToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface GatewayChatRequest {
  node_id: string;
  conversation_id: string;
  task: string;
  model: string;
  messages: GatewayMessage[];
  tools?: GatewayToolDefinition[];
  tool_choice?: "auto" | "none";
}

export interface ModelClientResult {
  reply: string;
  tool_calls?: GatewayToolCall[];
  request_id?: string;
  usage?: unknown;
}

export type ModelClient = (chat: GatewayChatRequest) => Promise<ModelClientResult>;
export type TokenVerifier = (token: string) => boolean | Promise<boolean>;
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
