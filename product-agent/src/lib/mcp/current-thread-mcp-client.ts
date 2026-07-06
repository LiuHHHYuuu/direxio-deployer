import type { GatewayMessage } from "../types.js";

export interface CurrentThreadSearchInput {
  nodeId: string;
  conversationId: string;
  query: string;
  limit: number;
}

export interface CurrentThreadSearchResult {
  messages: GatewayMessage[];
  source?: string;
}

export interface CurrentThreadMcpClient {
  searchCurrentThread(input: CurrentThreadSearchInput): Promise<CurrentThreadSearchResult>;
}
