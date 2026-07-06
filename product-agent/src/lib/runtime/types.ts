import type { HostedGatewayResult } from "../hosted-gateway-client.js";
import type { FetchLike, GatewayChatRequest } from "../types.js";

export interface AgentRuntimeRunOptions {
  event: Record<string, unknown>;
  payload: GatewayChatRequest;
  gatewayUrl: string;
  aiToken: string;
  fetchImpl: FetchLike;
}

export type AgentRuntimeResult = HostedGatewayResult;

export interface AgentRuntime {
  run(options: AgentRuntimeRunOptions): Promise<AgentRuntimeResult>;
}
