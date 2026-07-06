import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { BaseMessageLike } from "@langchain/core/messages";
import { createAgent, tool } from "langchain";
import { z } from "zod";
import { InMemoryThreadMemoryStore, type ThreadMemorySnapshot, type ThreadMemoryStore } from "../memory/thread-memory.js";
import { DirexioGatewayChatModel, DirexioGatewayChatModelError } from "../models/direxio-gateway-chat-model.js";
import { createDirexioReadOnlyTools } from "../tools/direxio-tools.js";
import type { AgentTool, AgentToolContext } from "../tools/types.js";
import type { FetchLike, GatewayMessage } from "../types.js";
import type { AgentRuntime, AgentRuntimeRunOptions, AgentRuntimeResult } from "./types.js";

export interface LangChainAgentRuntimeOptions {
  memoryStore?: ThreadMemoryStore;
  tools?: AgentTool[];
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  checkpointer?: BaseCheckpointSaver;
}

export function createLangChainAgentRuntime(options: LangChainAgentRuntimeOptions = {}): AgentRuntime {
  return new LangChainAgentRuntime(options);
}

class LangChainAgentRuntime implements AgentRuntime {
  private readonly memoryStore: ThreadMemoryStore;
  private readonly tools: AgentTool[];
  private readonly fetchImpl: FetchLike;
  private readonly env: NodeJS.ProcessEnv;
  private readonly checkpointer: BaseCheckpointSaver;

  constructor(options: LangChainAgentRuntimeOptions) {
    this.memoryStore = options.memoryStore || new InMemoryThreadMemoryStore();
    this.tools = options.tools || createDirexioReadOnlyTools();
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.env = options.env || process.env;
    this.checkpointer = options.checkpointer || new MemorySaver();
  }

  async run(options: AgentRuntimeRunOptions): Promise<AgentRuntimeResult> {
    this.memoryStore.rememberMessages(options.payload.conversation_id, options.payload.messages);
    const memory = this.memoryStore.snapshot(options.payload.conversation_id);
    const toolContext: AgentToolContext = {
      event: options.event,
      payload: options.payload,
      memory,
      fetchImpl: options.fetchImpl || this.fetchImpl,
      env: this.env
    };
    const model = new DirexioGatewayChatModel({
      gatewayUrl: options.gatewayUrl,
      aiToken: options.aiToken,
      nodeId: options.payload.node_id,
      conversationId: options.payload.conversation_id,
      task: options.payload.task,
      model: options.payload.model,
      fetchImpl: options.fetchImpl || this.fetchImpl
    });
    const agent = createAgent({
      model,
      tools: this.tools.map((agentTool) => createLangChainTool(agentTool, toolContext)),
      checkpointer: this.checkpointer,
      systemPrompt: buildSystemPrompt(memory)
    });

    try {
      const result = await agent.invoke(
        { messages: options.payload.messages.map(toLangChainMessageLike) },
        { configurable: { thread_id: options.payload.conversation_id } }
      );
      const reply = finalAssistantReply(result);
      if (!reply.trim()) {
        return {
          ok: false,
          status: 502,
          error: {
            code: "bad_agent_response",
            message: "Direxio AI returned an empty agent response."
          }
        };
      }
      this.memoryStore.rememberAssistantReply(options.payload.conversation_id, reply);
      return { ok: true, reply };
    } catch (error) {
      if (error instanceof DirexioGatewayChatModelError) {
        return error.failure;
      }
      return {
        ok: false,
        status: 503,
        error: {
          code: "agent_runtime_error",
          message: "Direxio AI agent runtime failed. Please try again later."
        }
      };
    }
  }
}

function createLangChainTool(agentTool: AgentTool, context: AgentToolContext) {
  return tool(
    async (input: unknown) => {
      const result = await agentTool.run(asRecord(input), context);
      return result.ok ? result.content : `Tool ${agentTool.name} failed: ${result.content}`;
    },
    {
      name: agentTool.name,
      description: agentTool.description,
      schema: schemaForTool(agentTool.name)
    }
  );
}

function schemaForTool(name: string) {
  if (name === "list_recent_ai_messages") {
    return z.object({
      limit: z.number().int().min(1).max(20).optional().describe("Maximum number of recent messages to read.")
    });
  }
  if (name === "search_current_ai_thread") {
    return z.object({
      query: z.string().min(1).describe("Text to search for in the current Direxio AI thread.")
    });
  }
  if (name === "web_search") {
    return z.object({
      query: z.string().min(1).describe("Public web search query.")
    });
  }
  return z.object({});
}

function buildSystemPrompt(memory: ThreadMemorySnapshot): string {
  const preferences = Object.entries(memory.preferences);
  const memoryBlock = preferences.length
    ? `Thread memory:\n${preferences.map(([key, value]) => `- ${key}: ${value}`).join("\n")}`
    : "";
  return [
    "You are Direxio AI, a helpful AI friend inside a private Direxio conversation.",
    "Use local read-only tools only when they help answer the user. Do not claim access to conversations or contacts unless a tool result provides that data.",
    "Keep answers concise by default, and explain tool limits plainly when a requested tool is disabled.",
    memoryBlock
  ].filter(Boolean).join("\n\n");
}

function toLangChainMessageLike(message: GatewayMessage): BaseMessageLike {
  const role = message.role === "user" ? "user" : message.role;
  return {
    role,
    content: message.content,
    ...(message.name ? { name: message.name } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {})
  };
}

function finalAssistantReply(result: unknown): string {
  const messages = asRecord(result).messages;
  if (!Array.isArray(messages)) return "";
  for (const message of [...messages].reverse()) {
    const record = asRecord(message);
    const type = stringValue(record.type) || stringValue(record.role);
    if (type !== "ai" && type !== "assistant") continue;
    const content = contentString(record.content);
    if (content.trim()) return content.trim();
  }
  return "";
}

function contentString(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      const record = asRecord(part);
      return stringValue(record.text) || JSON.stringify(record);
    })
    .join("");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}
