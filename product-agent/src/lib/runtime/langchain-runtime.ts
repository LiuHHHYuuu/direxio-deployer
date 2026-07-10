import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { BaseMessageLike } from "@langchain/core/messages";
import { createAgent, tool } from "langchain";
import { z } from "zod";
import {
  normalizeAgentAction,
  parseAgentActionContent,
  toolNameForAgentAction
} from "../abilities/action-protocol.js";
import { runAutomaticMemory } from "../memory/automatic-memory.js";
import {
  GatewayMemoryCandidateExtractor,
  type MemoryCandidateExtractor
} from "../memory/memory-extractor.js";
import {
  InMemoryThreadMemoryStore,
  latestUserMessageContent,
  withRelevantMemories,
  type ThreadMemorySnapshot,
  type ThreadMemoryStore
} from "../memory/thread-memory.js";
import type { CurrentThreadMcpClient } from "../mcp/current-thread-mcp-client.js";
import { DirexioGatewayChatModel, DirexioGatewayChatModelError } from "../models/direxio-gateway-chat-model.js";
import type { PromptSkillStore } from "../skills/prompt-skill-store.js";
import { createAgentToolRegistry } from "../tools/registry.js";
import {
  agentActionResultContentFromText,
  agentActionResultSummaryFromText
} from "../tools/structured-output.js";
import type { AgentTool, AgentToolContext } from "../tools/types.js";
import type { FetchLike, GatewayMessage } from "../types.js";
import { flagFromEnv, numberFromEnv } from "./runtime-config.js";
import type { AgentRuntime, AgentRuntimeRunOptions, AgentRuntimeResult } from "./types.js";

export interface LangChainAgentRuntimeOptions {
  memoryStore?: ThreadMemoryStore;
  tools?: AgentTool[];
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  checkpointer?: BaseCheckpointSaver;
  maxModelCalls?: number;
  gatewayTimeoutMs?: number;
  currentThreadMcpClient?: CurrentThreadMcpClient;
  promptSkillStore?: PromptSkillStore;
  memoryExtractor?: MemoryCandidateExtractor;
  autoMemoryEnabled?: boolean;
}

export function createLangChainAgentRuntime(options: LangChainAgentRuntimeOptions = {}): AgentRuntime {
  return new LangChainAgentRuntime(options);
}

class AgentModelCallLimitError extends Error {
  constructor(readonly maxModelCalls: number) {
    super(`agent model call limit reached: ${maxModelCalls}`);
    this.name = "AgentModelCallLimitError";
  }
}

interface DirectCardRuntimeResult {
  ok: true;
  reply: string;
  outboundContent: string;
}

class LangChainAgentRuntime implements AgentRuntime {
  private readonly memoryStore: ThreadMemoryStore;
  private readonly staticTools?: AgentTool[];
  private readonly currentThreadMcpClient?: CurrentThreadMcpClient;
  private readonly promptSkillStore?: PromptSkillStore;
  private readonly fetchImpl: FetchLike;
  private readonly env: NodeJS.ProcessEnv;
  private readonly checkpointer: BaseCheckpointSaver;
  private readonly maxModelCalls: number;
  private readonly gatewayTimeoutMs: number;
  private readonly runtimeLogEnabled: boolean;
  private readonly memoryExtractor: MemoryCandidateExtractor;
  private readonly autoMemoryEnabled: boolean;
  private readonly autoMemoryTimeoutMs: number;
  private readonly autoMemoryMaxCandidates: number;
  private readonly autoMemoryMinConfidence: number;
  private readonly autoMemoryMinImportance: number;

  constructor(options: LangChainAgentRuntimeOptions) {
    this.env = options.env || process.env;
    this.memoryStore = options.memoryStore || new InMemoryThreadMemoryStore();
    this.staticTools = options.tools;
    this.currentThreadMcpClient = options.currentThreadMcpClient;
    this.promptSkillStore = options.promptSkillStore;
    this.memoryExtractor = options.memoryExtractor || new GatewayMemoryCandidateExtractor();
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.checkpointer = options.checkpointer || new MemorySaver();
    this.maxModelCalls = options.maxModelCalls || numberFromEnv({
      env: this.env,
      key: "DIREXIO_AGENT_MAX_MODEL_CALLS",
      fallback: 3,
      min: 1,
      max: 10
    });
    this.gatewayTimeoutMs = options.gatewayTimeoutMs || numberFromEnv({
      env: this.env,
      key: "DIREXIO_AGENT_GATEWAY_TIMEOUT_MS",
      fallback: 30000,
      min: 1,
      max: 120000
    });
    this.runtimeLogEnabled = flagFromEnv(this.env, "DIREXIO_AGENT_RUNTIME_LOG");
    this.autoMemoryEnabled = options.autoMemoryEnabled ?? enabledByDefault(this.env, "DIREXIO_AGENT_AUTO_MEMORY");
    this.autoMemoryTimeoutMs = numberFromEnv({
      env: this.env,
      key: "DIREXIO_AGENT_AUTO_MEMORY_TIMEOUT_MS",
      fallback: 5000,
      min: 100,
      max: 30000
    });
    this.autoMemoryMaxCandidates = numberFromEnv({
      env: this.env,
      key: "DIREXIO_AGENT_AUTO_MEMORY_MAX_CANDIDATES",
      fallback: 3,
      min: 1,
      max: 10
    });
    this.autoMemoryMinConfidence = scoreFromEnv(this.env, "DIREXIO_AGENT_AUTO_MEMORY_MIN_CONFIDENCE", 0.8);
    this.autoMemoryMinImportance = scoreFromEnv(this.env, "DIREXIO_AGENT_AUTO_MEMORY_MIN_IMPORTANCE", 0.55);
  }

  async run(options: AgentRuntimeRunOptions): Promise<AgentRuntimeResult> {
    let modelCalls = 0;
    let outboundContent = "";
    this.memoryStore.rememberMessages(options.payload.conversation_id, options.payload.messages);
    const snapshot = this.memoryStore.snapshot(options.payload.conversation_id);
    const effectiveFetch = options.fetchImpl || this.fetchImpl;
    const relevantMemories = await this.memoryStore.searchMemories(options.payload.conversation_id, {
      query: latestUserMessageContent(options.payload.messages),
      limit: 5,
      fetchImpl: effectiveFetch,
      env: this.env,
      event: options.event
    });
    const memory = withRelevantMemories(snapshot, relevantMemories);
    const tools = this.toolsForRun();
    const toolContext: AgentToolContext = {
      event: options.event,
      payload: options.payload,
      memory,
      memoryStore: this.memoryStore,
      fetchImpl: effectiveFetch,
      env: this.env
    };
    const directCard = await runDirectExperienceCardTool({
      event: options.event,
      payload: options.payload,
      tools,
      context: toolContext,
      logEnabled: this.runtimeLogEnabled
    });
    if (directCard) {
      this.memoryStore.rememberAssistantReply(options.payload.conversation_id, directCard.reply);
      return directCard;
    }
    const model = new DirexioGatewayChatModel({
      gatewayUrl: options.gatewayUrl,
      aiToken: options.aiToken,
      nodeId: options.payload.node_id,
      conversationId: options.payload.conversation_id,
      task: options.payload.task,
      model: options.payload.model,
      fetchImpl: effectiveFetch,
      gatewayTimeoutMs: this.gatewayTimeoutMs,
      beforeGatewayCall: () => {
        if (modelCalls >= this.maxModelCalls) {
          logRuntimeEvent(this.runtimeLogEnabled, {
            type: "agent_model_call_limit",
            max_model_calls: this.maxModelCalls
          });
          throw new AgentModelCallLimitError(this.maxModelCalls);
        }
        modelCalls += 1;
        logRuntimeEvent(this.runtimeLogEnabled, {
          type: "agent_model_call",
          model_call: modelCalls,
          max_model_calls: this.maxModelCalls
        });
      }
    });
    const agent = createAgent({
      model,
      tools: tools.map((agentTool) => createLangChainTool(
        agentTool,
        toolContext,
        this.runtimeLogEnabled,
        (content) => {
          outboundContent = content;
        }
      )),
      checkpointer: this.checkpointer,
      systemPrompt: buildSystemPrompt(memory)
    });

    try {
      const result = await agent.invoke(
        { messages: options.payload.messages.map(toLangChainMessageLike) },
        {
          configurable: { thread_id: options.payload.conversation_id },
          recursionLimit: recursionLimitForModelCalls(this.maxModelCalls)
        }
      );
      const rawReply = finalAssistantReply(result);
      const finalStructuredContent = agentActionResultContentFromText(rawReply);
      const effectiveOutboundContent = finalStructuredContent || outboundContent;
      const structuredSummary = effectiveOutboundContent
        ? agentActionResultSummaryFromText(effectiveOutboundContent)
        : "";
      const reply = finalStructuredContent
        ? structuredSummary || "Agent card"
        : rawReply || structuredSummary;
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
      await this.rememberAutomatically({
        options,
        reply,
        recentMessages: memory.recentMessages,
        fetchImpl: effectiveFetch
      });
      return {
        ok: true,
        reply,
        ...(effectiveOutboundContent ? { outboundContent: effectiveOutboundContent } : {})
      };
    } catch (error) {
      if (error instanceof AgentModelCallLimitError) {
        return {
          ok: false,
          status: 429,
          error: {
            code: "agent_model_call_limit",
            message: "Direxio AI stopped because the agent used too many model calls."
          }
        };
      }
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

  private toolsForRun(): AgentTool[] {
    return this.staticTools || createAgentToolRegistry({
      currentThreadMcpClient: this.currentThreadMcpClient,
      promptSkillStore: this.promptSkillStore
    }).tools;
  }

  private async rememberAutomatically({
    options,
    reply,
    recentMessages,
    fetchImpl
  }: {
    options: AgentRuntimeRunOptions;
    reply: string;
    recentMessages: GatewayMessage[];
    fetchImpl: FetchLike;
  }): Promise<void> {
    if (!this.autoMemoryEnabled) return;
    const startedAt = Date.now();
    try {
      const changes = await runAutomaticMemory({
        extractor: this.memoryExtractor,
        store: this.memoryStore,
        nodeId: options.payload.node_id,
        conversationId: options.payload.conversation_id,
        model: options.payload.model,
        latestUserMessage: latestUserMessageContent(options.payload.messages),
        assistantReply: reply,
        recentMessages: [...recentMessages, { role: "assistant", content: reply }],
        gatewayUrl: options.gatewayUrl,
        aiToken: options.aiToken,
        fetchImpl,
        timeoutMs: this.autoMemoryTimeoutMs,
        maxCandidates: this.autoMemoryMaxCandidates,
        minConfidence: this.autoMemoryMinConfidence,
        minImportance: this.autoMemoryMinImportance
      });
      logRuntimeEvent(this.runtimeLogEnabled, {
        type: "agent_auto_memory",
        ok: true,
        changes: changes.filter((change) => change.action !== "noop").length,
        duration_ms: Date.now() - startedAt
      });
    } catch (error) {
      logRuntimeEvent(this.runtimeLogEnabled, {
        type: "agent_auto_memory",
        ok: false,
        duration_ms: Date.now() - startedAt,
        error_name: error instanceof Error ? error.name : "UnknownError"
      });
    }
  }
}

async function runDirectExperienceCardTool({
  event,
  payload,
  tools,
  context,
  logEnabled
}: {
  event: Record<string, unknown>;
  payload: { messages: GatewayMessage[] };
  tools: AgentTool[];
  context: AgentToolContext;
  logEnabled: boolean;
}): Promise<DirectCardRuntimeResult | null> {
  const invocation = directExperienceCardInvocation(event, payload.messages);
  if (!invocation) return null;
  const agentTool = tools.find((item) => item.name === invocation.name);
  if (!agentTool) return null;
  const startedAt = Date.now();
  try {
    const result = await agentTool.run(invocation.input, context);
    const outboundContent = result.ok ? agentActionResultContentFromText(result.content) : "";
    logRuntimeEvent(logEnabled, {
      type: "agent_direct_card_tool",
      tool_name: agentTool.name,
      ok: result.ok && Boolean(outboundContent),
      duration_ms: Date.now() - startedAt
    });
    if (!outboundContent) return null;
    return {
      ok: true,
      reply: agentActionResultSummaryFromText(outboundContent) || "Agent card",
      outboundContent
    };
  } catch (error) {
    logRuntimeEvent(logEnabled, {
      type: "agent_direct_card_tool",
      tool_name: agentTool.name,
      ok: false,
      duration_ms: Date.now() - startedAt,
      error_name: error instanceof Error ? error.name : "UnknownError"
    });
    return null;
  }
}

function directExperienceCardInvocation(
  event: Record<string, unknown>,
  messages: GatewayMessage[]
): { name: string; input: Record<string, unknown> } | null {
  const latestUser = [...messages].reverse().find((message) => message.role === "user");
  const text = latestUser?.content || "";
  const action = normalizeAgentAction(event.agent_action) || parseAgentActionContent(text);
  if (action) {
    return {
      name: toolNameForAgentAction(action.action),
      input: { focus: action.focus || "", limit: action.limit || 12 }
    };
  }
  const name = directExperienceCardToolNameFromText(text);
  return name ? { name, input: { focus: extractDirectExperienceFocus(text), limit: 12 } } : null;
}

function directExperienceCardToolNameFromText(text: string): string {
  const normalized = text.trim().toLowerCase();
  if (!normalized || containsAny(normalized, ["什么是", "what is", "explain", "解释"])) return "";
  const commandLike = normalized.length <= 40 || containsAny(normalized, [
    "生成",
    "创建",
    "做",
    "看看",
    "看一下",
    "帮我",
    "来一张",
    "make",
    "create",
    "generate",
    "show"
  ]);
  if (!commandLike) return "";
  if (containsAny(normalized, ["今日状态卡", "状态卡", "mood card", "status card", "mood snapshot"])) {
    return "create_mood_card";
  }
  if (containsAny(normalized, ["记忆胶囊", "对话总结", "复盘卡", "memory capsule", "thread recap", "recap card"])) {
    return "create_memory_capsule";
  }
  if (containsAny(normalized, ["数字人格卡", "人格卡", "互动风格", "persona card", "digital persona", "profile card", "personality card"])) {
    return "create_persona_card";
  }
  return "";
}

function extractDirectExperienceFocus(text: string): string {
  return text
    .replace(/^(请|帮我|给我|生成|创建|做|看看|看一下|来一张)\s*/u, "")
    .replace(/^(please|make|create|generate|show)\s+/i, "")
    .trim();
}

function containsAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function createLangChainTool(
  agentTool: AgentTool,
  context: AgentToolContext,
  logEnabled: boolean,
  captureStructuredContent: (content: string) => void
) {
  return tool(
    async (input: unknown) => {
      const startedAt = Date.now();
      try {
        const result = await agentTool.run(asRecord(input), context);
        const structuredContent = agentActionResultContentFromText(result.content);
        if (structuredContent) captureStructuredContent(structuredContent);
        logRuntimeEvent(logEnabled, {
          type: "agent_tool_call",
          tool_name: agentTool.name,
          ok: result.ok,
          duration_ms: Date.now() - startedAt
        });
        return result.ok ? result.content : `Tool ${agentTool.name} failed: ${result.content}`;
      } catch (error) {
        logRuntimeEvent(logEnabled, {
          type: "agent_tool_call",
          tool_name: agentTool.name,
          ok: false,
          duration_ms: Date.now() - startedAt,
          error_name: error instanceof Error ? error.name : "UnknownError"
        });
        throw error;
      }
    },
    {
      name: agentTool.name,
      description: agentTool.description,
      schema: schemaForTool(agentTool.name)
    }
  );
}

function recursionLimitForModelCalls(maxModelCalls: number): number {
  return Math.max(6, maxModelCalls * 4 + 4);
}

function logRuntimeEvent(enabled: boolean, event: Record<string, unknown>): void {
  if (!enabled) return;
  console.info(JSON.stringify({
    component: "direxio_product_agent",
    ...event
  }));
}

function enabledByDefault(env: NodeJS.ProcessEnv, key: string): boolean {
  const value = env[key]?.trim().toLowerCase();
  return value !== "0" && value !== "false";
}

function scoreFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = Number(env[key]);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
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
  if (name === "memory_list") {
    return z.object({
      limit: z.number().int().min(1).max(50).optional().describe("Maximum memory items to list.")
    });
  }
  if (name === "memory_search") {
    return z.object({
      query: z.string().min(1).describe("Memory search query."),
      limit: z.number().int().min(1).max(20).optional().describe("Maximum memory items to return.")
    });
  }
  if (name === "memory_save") {
    return z.object({
      text: z.string().min(1).describe("Explicit memory text the user asked the agent to remember."),
      type: z.enum(["fact", "preference", "card_memory", "skill_result"]).optional().describe("Memory item type."),
      tags: z.array(z.string()).max(12).optional().describe("Short labels for this memory.")
    });
  }
  if (name === "memory_delete") {
    return z.object({
      id: z.string().min(1).describe("Memory item id to delete.")
    });
  }
  if (name === "mcp_current_thread_search") {
    return z.object({
      query: z.string().min(1).describe("Text to search for in the current Direxio AI thread through MCP."),
      limit: z.number().int().min(1).max(20).optional().describe("Maximum matching messages to read.")
    });
  }
  if (isExperienceCardTool(name)) {
    return z.object({
      focus: z.string().min(1).optional().describe("Optional focus for the private experience card."),
      limit: z.number().int().min(1).max(20).optional().describe("Maximum current-thread user messages to consider.")
    });
  }
  if (name.startsWith("prompt_skill_")) {
    return z.object({
      user_message: z.string().optional().describe("The user's message that triggered this Prompt Skill.")
    });
  }
  return z.object({});
}

function isExperienceCardTool(name: string): boolean {
  return name === "create_persona_card" ||
    name === "create_memory_capsule" ||
    name === "create_mood_card";
}

/**
 * Function: Builds the LangChain system prompt with explicit local memory.
 * Inputs:
 * - memory: Snapshot for the current Direxio AI conversation.
 * Output:
 * - System prompt text passed to the LangChain agent.
 * Side effects:
 * - None; memory is read-only at prompt construction time.
 * Errors:
 * - None.
 */
function buildSystemPrompt(memory: ThreadMemorySnapshot): string {
  const relevant = (memory.relevantMemories || [])
    .map((item) => item.text)
    .filter(Boolean)
    .slice(0, 5);
  const preferences = Object.entries(memory.preferences);
  const facts = memory.persistentMemories
    .filter((item) => item.type !== "preference")
    .filter((item) => !relevant.includes(item.text))
    .map((item) => item.text)
    .slice(-8);
  const memoryLines = [
    ...relevant.map((text) => `- relevant: ${text}`),
    ...preferences.map(([key, value]) => `- ${key}: ${value}`),
    ...facts.map((text) => `- ${text}`)
  ];
  const memoryBlock = memoryLines.length
    ? `Thread memory:\n${memoryLines.join("\n")}`
    : "";
  return [
    "You are Direxio AI, a helpful AI friend inside a private Direxio conversation.",
    "Use local read-only tools only when they help answer the user. Do not claim access to conversations or contacts unless a tool result provides that data.",
    "For weather, news, recent facts, prices, or anything time-sensitive, call web_search before answering.",
    "If the user asks to generate a status card, mood card, memory capsule, recap card, persona card, or interaction style card, call the matching card tool.",
    "Card tools already include approved thread memory. Do not call memory_save for a generated card unless the user explicitly asks to remember or save it.",
    "Keep answers concise by default, and explain tool limits plainly when a requested tool is disabled.",
    "When a tool returns direxio.agent_action_result.v1, render a compact card: title, one-sentence summary, up to three bullets, and one next action. Do not paste raw JSON.",
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
