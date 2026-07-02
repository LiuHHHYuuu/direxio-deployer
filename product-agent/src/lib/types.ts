export type ChatRole = "user" | "assistant" | "system";

export interface GatewayMessage {
  role: ChatRole;
  content: string;
}

export interface GatewayChatRequest {
  node_id: string;
  conversation_id: string;
  task: string;
  model: string;
  messages: GatewayMessage[];
}

export interface ModelClientResult {
  reply: string;
  request_id?: string;
  usage?: unknown;
}

export type ModelClient = (chat: GatewayChatRequest) => Promise<ModelClientResult>;
export type TokenVerifier = (token: string) => boolean | Promise<boolean>;
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
