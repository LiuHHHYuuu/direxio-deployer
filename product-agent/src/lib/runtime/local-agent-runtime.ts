import { InMemoryThreadMemoryStore, type ThreadMemoryStore } from "../memory/thread-memory.js";
import { createDirexioReadOnlyTools } from "../tools/direxio-tools.js";
import { memoryAsSystemMessage, runSelectedAgentTools, toolResultsAsSystemMessage } from "../tools/runner.js";
import type { AgentTool } from "../tools/types.js";
import type { FetchLike, GatewayChatRequest } from "../types.js";

export interface LocalAgentRuntimeOptions {
  memoryStore?: ThreadMemoryStore;
  tools?: AgentTool[];
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

export interface PrepareAgentPayloadOptions {
  event: Record<string, unknown>;
  payload: GatewayChatRequest;
}

export interface PreparedAgentPayload {
  payload: GatewayChatRequest;
  rememberAssistantReply(reply: string): void;
}

export interface LocalAgentRuntime {
  preparePayload(options: PrepareAgentPayloadOptions): Promise<PreparedAgentPayload>;
}

export function createLocalAgentRuntime(options: LocalAgentRuntimeOptions = {}): LocalAgentRuntime {
  const memoryStore = options.memoryStore || new InMemoryThreadMemoryStore();
  const tools = options.tools || createDirexioReadOnlyTools();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const env = options.env || process.env;

  return {
    async preparePayload({ event, payload }) {
      memoryStore.rememberMessages(payload.conversation_id, payload.messages);
      const memory = memoryStore.snapshot(payload.conversation_id);
      const toolResults = await runSelectedAgentTools({
        event,
        payload,
        memory,
        tools,
        fetchImpl,
        env
      });

      const contextMessages = [
        memoryAsSystemMessage(memory),
        toolResultsAsSystemMessage(toolResults)
      ].filter((message): message is NonNullable<typeof message> => Boolean(message));

      return {
        payload: {
          ...payload,
          messages: [...contextMessages, ...payload.messages]
        },
        rememberAssistantReply(reply: string) {
          memoryStore.rememberAssistantReply(payload.conversation_id, reply);
        }
      };
    }
  };
}
