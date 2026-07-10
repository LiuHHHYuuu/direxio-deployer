import {
  InMemoryThreadMemoryStore,
  latestUserMessageContent,
  withRelevantMemories,
  type ThreadMemoryStore
} from "../memory/thread-memory.js";
import type { CurrentThreadMcpClient } from "../mcp/current-thread-mcp-client.js";
import type { PromptSkillStore } from "../skills/prompt-skill-store.js";
import { callHostedGateway } from "../hosted-gateway-client.js";
import { createAgentToolRegistry } from "../tools/registry.js";
import { memoryAsSystemMessage, runSelectedAgentTools, toolResultsAsSystemMessage } from "../tools/runner.js";
import {
  agentActionResultContentFromText,
  agentActionResultContentFromToolResults,
  agentActionResultSummaryFromText
} from "../tools/structured-output.js";
import type { AgentTool } from "../tools/types.js";
import type { FetchLike, GatewayChatRequest } from "../types.js";
import { numberFromEnv } from "./runtime-config.js";
import type { AgentRuntime, AgentRuntimeRunOptions } from "./types.js";

export interface LocalAgentRuntimeOptions {
  memoryStore?: ThreadMemoryStore;
  tools?: AgentTool[];
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  currentThreadMcpClient?: CurrentThreadMcpClient;
  promptSkillStore?: PromptSkillStore;
}

export interface PrepareAgentPayloadOptions {
  event: Record<string, unknown>;
  payload: GatewayChatRequest;
  gatewayUrl?: string;
  aiToken?: string;
}

export interface PreparedAgentPayload {
  payload: GatewayChatRequest;
  outboundContent?: string;
  rememberAssistantReply(reply: string): void;
}

export interface LocalAgentRuntime extends AgentRuntime {
  preparePayload(options: PrepareAgentPayloadOptions): Promise<PreparedAgentPayload>;
}

export function createLocalAgentRuntime(options: LocalAgentRuntimeOptions = {}): LocalAgentRuntime {
  const memoryStore = options.memoryStore || new InMemoryThreadMemoryStore();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const env = options.env || process.env;
  const gatewayTimeoutMs = numberFromEnv({
    env,
    key: "DIREXIO_AGENT_GATEWAY_TIMEOUT_MS",
    fallback: 30000,
    min: 1,
    max: 120000
  });

  return {
    async run(options: AgentRuntimeRunOptions) {
      const prepared = await this.preparePayload({
        event: options.event,
        payload: options.payload,
        gatewayUrl: options.gatewayUrl,
        aiToken: options.aiToken
      });
      const gatewayResponse = await callHostedGateway({
        gatewayUrl: options.gatewayUrl,
        aiToken: options.aiToken,
        payload: prepared.payload,
        fetchImpl: options.fetchImpl || fetchImpl,
        timeoutMs: gatewayTimeoutMs
      });
      if (gatewayResponse.ok) {
        const finalStructuredContent = agentActionResultContentFromText(gatewayResponse.reply);
        const outboundContent = finalStructuredContent || prepared.outboundContent;
        const structuredSummary = outboundContent
          ? agentActionResultSummaryFromText(outboundContent)
          : "";
        const reply = finalStructuredContent
          ? structuredSummary || "Agent card"
          : gatewayResponse.reply || structuredSummary;
        prepared.rememberAssistantReply(reply);
        if (outboundContent) {
          return {
            ...gatewayResponse,
            reply,
            outboundContent
          };
        }
        return {
          ...gatewayResponse,
          reply
        };
      }
      return gatewayResponse;
    },
    async preparePayload({ event, payload, gatewayUrl, aiToken }) {
      memoryStore.rememberMessages(payload.conversation_id, payload.messages);
      const snapshot = memoryStore.snapshot(payload.conversation_id);
      const relevantMemories = await memoryStore.searchMemories(payload.conversation_id, {
        query: latestUserMessageContent(payload.messages),
        limit: 5,
        fetchImpl,
        env,
        event
      });
      const memory = withRelevantMemories(snapshot, relevantMemories);
      const tools = options.tools || createAgentToolRegistry({
        currentThreadMcpClient: options.currentThreadMcpClient,
        promptSkillStore: options.promptSkillStore
      }).tools;
      const toolResults = await runSelectedAgentTools({
        event,
        payload,
        memory,
        memoryStore,
        tools,
        fetchImpl,
        env,
        gatewayUrl,
        aiToken
      });
      const outboundContent = agentActionResultContentFromToolResults(toolResults);

      const contextMessages = [
        memoryAsSystemMessage(memory),
        toolResultsAsSystemMessage(toolResults)
      ].filter((message): message is NonNullable<typeof message> => Boolean(message));

      return {
        payload: {
          ...payload,
          messages: [...contextMessages, ...payload.messages]
        },
        ...(outboundContent ? { outboundContent } : {}),
        rememberAssistantReply(reply: string) {
          memoryStore.rememberAssistantReply(payload.conversation_id, reply);
        }
      };
    }
  };
}
