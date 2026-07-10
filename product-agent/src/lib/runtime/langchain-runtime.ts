import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { BaseMessageLike } from "@langchain/core/messages";
import { createAgent, tool } from "langchain";
import { z } from "zod";
import {
  normalizeAgentAction,
  parseAgentActionContent,
  toolNameForAgentAction
} from "../abilities/action-protocol.js";
import type { AgentActionName } from "../abilities/types.js";
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
import {
  GatewayCardGenerationSkill,
  type CardGenerationSkill
} from "../skills/card-generation-skill.js";
import { createAgentToolRegistry } from "../tools/registry.js";
import {
  agentActionResultContentFromText,
  agentActionResultSummaryFromText
} from "../tools/structured-output.js";
import type { AgentTool, AgentToolContext } from "../tools/types.js";
import type { FetchLike, GatewayMessage } from "../types.js";
import { flagFromEnv, numberFromEnv } from "./runtime-config.js";
import { planCardDecision, ProactiveCardGate, type CardDecision } from "./card-planner.js";
import {
  completionRetryInstruction,
  clarificationReply,
  EvidenceLedger,
  externalEvidenceFailureReply,
  findToolForCapabilities,
  planTask,
  validateCompletion,
  type TaskPlan
} from "./task-control.js";
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
  cardSkill?: CardGenerationSkill;
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
  private readonly cardSkill: CardGenerationSkill;
  private readonly dynamicCardsEnabled: boolean;
  private readonly proactiveCardsEnabled: boolean;
  private readonly proactiveCardGate: ProactiveCardGate;

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
    this.cardSkill = options.cardSkill || new GatewayCardGenerationSkill();
    this.dynamicCardsEnabled = enabledByDefault(this.env, "DIREXIO_AGENT_DYNAMIC_CARDS");
    this.proactiveCardsEnabled = enabledByDefault(this.env, "DIREXIO_AGENT_PROACTIVE_CARDS");
    this.proactiveCardGate = new ProactiveCardGate(numberFromEnv({
      env: this.env,
      key: "DIREXIO_AGENT_CARD_COOLDOWN_MINUTES",
      fallback: 360,
      min: 1,
      max: 10080
    }) * 60000);
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
      env: this.env,
      gatewayUrl: options.gatewayUrl,
      aiToken: options.aiToken
    };
    const explicitCardInvocation = directExperienceCardInvocation(options.event, options.payload.messages);
    if (explicitCardInvocation) {
      const decision = planCardDecision({
        messages: options.payload.messages,
        requestedAction: actionForCardToolName(explicitCardInvocation.name),
        allowProactive: false
      });
      if (decision) {
        const directCard = await runPlannedExperienceCard({
          decision,
          focus: stringValue(explicitCardInvocation.input.focus),
          limit: numberValue(explicitCardInvocation.input.limit, 12),
          options,
          tools,
          context: toolContext,
          cardSkill: this.cardSkill,
          dynamicCardsEnabled: this.dynamicCardsEnabled,
          gatewayTimeoutMs: this.gatewayTimeoutMs,
          logEnabled: this.runtimeLogEnabled
        });
        if (directCard) {
          this.memoryStore.rememberAssistantReply(options.payload.conversation_id, directCard.reply);
          return directCard;
        }
      }
    }
    const taskControlEnabled = enabledByDefault(this.env, "DIREXIO_AGENT_TASK_CONTROL");
    const taskPlan = taskControlEnabled
      ? planTask(latestUserMessageContent(options.payload.messages), memory)
      : directTaskPlan();
    const evidenceLedger = new EvidenceLedger();
    logRuntimeEvent(this.runtimeLogEnabled, {
      type: "agent_task_plan",
      mode: taskPlan.mode,
      required_capabilities: taskPlan.requiredCapabilities
    });
    if (taskPlan.mode === "clarify") {
      const reply = clarificationReply(latestUserMessageContent(options.payload.messages));
      this.memoryStore.rememberAssistantReply(options.payload.conversation_id, reply);
      return { ok: true, reply };
    }
    if (taskPlan.mode === "direct") {
      const decision = planCardDecision({
        messages: options.payload.messages,
        allowProactive: this.proactiveCardsEnabled
      });
      const allowed = decision && (!decision.proactive || this.proactiveCardGate.allow(options.payload.conversation_id));
      if (decision && allowed) {
        const card = await runPlannedExperienceCard({
          decision,
          focus: latestUserMessageContent(options.payload.messages),
          limit: 12,
          options,
          tools,
          context: toolContext,
          cardSkill: this.cardSkill,
          dynamicCardsEnabled: this.dynamicCardsEnabled,
          gatewayTimeoutMs: this.gatewayTimeoutMs,
          logEnabled: this.runtimeLogEnabled
        });
        if (card) {
          if (decision.proactive) this.proactiveCardGate.mark(options.payload.conversation_id);
          this.memoryStore.rememberAssistantReply(options.payload.conversation_id, card.reply);
          return card;
        }
      }
    }
    let requiredTool: AgentTool | undefined;
    if (taskPlan.mode === "external_evidence") {
      requiredTool = findToolForCapabilities(tools, taskPlan.requiredCapabilities);
      if (!requiredTool) {
        const reply = externalEvidenceFailureReply(latestUserMessageContent(options.payload.messages));
        this.memoryStore.rememberAssistantReply(options.payload.conversation_id, reply);
        return { ok: true, reply };
      }
      const startedAt = Date.now();
      let toolResult;
      try {
        toolResult = await requiredTool.run({ query: taskPlan.searchQuery || latestUserMessageContent(options.payload.messages) }, toolContext);
      } catch (error) {
        toolResult = {
          name: requiredTool.name,
          ok: false,
          content: error instanceof Error ? error.message : "Required tool failed."
        };
      }
      const evidence = evidenceLedger.record(requiredTool, toolResult);
      logRuntimeEvent(this.runtimeLogEnabled, {
        type: "agent_required_tool",
        tool_name: requiredTool.name,
        ok: evidence.ok,
        duration_ms: Date.now() - startedAt
      });
      if (!taskPlan.requiredCapabilities.every((capability) => evidenceLedger.satisfies(capability))) {
        const noResults = /no useful|no search results/i.test(toolResult.content);
        const reply = externalEvidenceFailureReply(latestUserMessageContent(options.payload.messages), noResults);
        this.memoryStore.rememberAssistantReply(options.payload.conversation_id, reply);
        return { ok: true, reply };
      }
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
    const toolsForAgent = requiredTool ? tools.filter((item) => item.name !== requiredTool?.name) : tools;
    const systemPrompt = buildSystemPrompt(memory, taskPlan, evidenceLedger);
    const agent = createAgent({
      model,
      tools: toolsForAgent.map((agentTool) => createLangChainTool(
        agentTool,
        toolContext,
        this.runtimeLogEnabled,
        evidenceLedger,
        (content) => {
          outboundContent = content;
        }
      )),
      checkpointer: this.checkpointer,
      systemPrompt
    });

    try {
      const result = await agent.invoke(
        { messages: options.payload.messages.map(toLangChainMessageLike) },
        {
          configurable: { thread_id: options.payload.conversation_id },
          recursionLimit: recursionLimitForModelCalls(this.maxModelCalls)
        }
      );
      let rawReply = finalAssistantReply(result);
      if (taskPlan.mode === "external_evidence") {
        let validation = validateCompletion(taskPlan, evidenceLedger, rawReply);
        logRuntimeEvent(this.runtimeLogEnabled, {
          type: "agent_completion_validation",
          ok: validation.ok,
          reason: validation.reason
        });
        if (!validation.ok) {
          logRuntimeEvent(this.runtimeLogEnabled, { type: "agent_answer_retry", retry_count: 1 });
          const retryMessage = await model.invoke([
            { role: "system", content: systemPrompt },
            ...options.payload.messages.map(toLangChainMessageLike),
            { role: "assistant", content: rawReply },
            { role: "system", content: completionRetryInstruction(validation.reason, evidenceLedger) }
          ]);
          rawReply = contentString(asRecord(retryMessage).content).trim();
          validation = validateCompletion(taskPlan, evidenceLedger, rawReply);
          logRuntimeEvent(this.runtimeLogEnabled, {
            type: "agent_completion_validation",
            ok: validation.ok,
            reason: validation.reason,
            retry_count: 1
          });
          if (!validation.ok) {
            const reply = externalEvidenceFailureReply(latestUserMessageContent(options.payload.messages));
            this.memoryStore.rememberAssistantReply(options.payload.conversation_id, reply);
            return { ok: true, reply };
          }
        }
      }
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

async function runPlannedExperienceCard({
  decision,
  focus,
  limit,
  options,
  tools,
  context,
  cardSkill,
  dynamicCardsEnabled,
  gatewayTimeoutMs,
  logEnabled
}: {
  decision: CardDecision;
  focus: string;
  limit: number;
  options: AgentRuntimeRunOptions;
  tools: AgentTool[];
  context: AgentToolContext;
  cardSkill: CardGenerationSkill;
  dynamicCardsEnabled: boolean;
  gatewayTimeoutMs: number;
  logEnabled: boolean;
}): Promise<DirectCardRuntimeResult | null> {
  const toolName = toolNameForAgentAction(decision.action);
  const agentTool = tools.find((item) => item.name === toolName);
  if (!agentTool) return null;
  const startedAt = Date.now();
  try {
    const fallbackResult = await agentTool.run({ focus, limit }, context);
    let outboundContent = fallbackResult.ok ? agentActionResultContentFromText(fallbackResult.content) : "";
    let generatedBy = "local_fallback";
    if (dynamicCardsEnabled) {
      const generated = await cardSkill.generate({
        action: decision.action,
        state: decision.state,
        focus,
        messages: options.payload.messages,
        memory: context.memory,
        nodeId: options.payload.node_id,
        conversationId: options.payload.conversation_id,
        model: options.payload.model,
        gatewayUrl: options.gatewayUrl,
        aiToken: options.aiToken,
        fetchImpl: options.fetchImpl,
        timeoutMs: gatewayTimeoutMs
      });
      if (generated.ok) {
        outboundContent = JSON.stringify(generated.card);
        generatedBy = "card_skill";
      }
    }
    logRuntimeEvent(logEnabled, {
      type: "agent_card_generation",
      tool_name: agentTool.name,
      ok: Boolean(outboundContent),
      proactive: decision.proactive,
      state: decision.state,
      generated_by: generatedBy,
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

function actionForCardToolName(name: string): AgentActionName | undefined {
  if (name === "create_persona_card") return "persona_card";
  if (name === "create_memory_capsule") return "memory_capsule";
  if (name === "create_mood_card") return "mood_card";
  return undefined;
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
  evidenceLedger: EvidenceLedger,
  captureStructuredContent: (content: string) => void
) {
  return tool(
    async (input: unknown) => {
      const startedAt = Date.now();
      try {
        const result = await agentTool.run(asRecord(input), context);
        evidenceLedger.record(agentTool, result);
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
function buildSystemPrompt(memory: ThreadMemorySnapshot, taskPlan?: TaskPlan, evidenceLedger?: EvidenceLedger): string {
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
  const evidenceBlock = taskPlan?.mode === "external_evidence" && evidenceLedger?.promptContext()
    ? [
        "Task control: current external evidence was required and has already been collected.",
        "Answer the user now from this evidence. Do not promise to search later or claim that web access is unavailable.",
        evidenceLedger.promptContext()
      ].join("\n")
    : "";
  return [
    "You are Direxio AI, a helpful AI friend inside a private Direxio conversation.",
    "Use local read-only tools only when they help answer the user. Do not claim access to conversations or contacts unless a tool result provides that data.",
    "For weather, news, recent facts, prices, or anything time-sensitive, call web_search before answering.",
    "If the user asks to generate a status card, mood card, memory capsule, recap card, persona card, or interaction style card, call the matching card tool.",
    "Card tools already include approved thread memory. Do not call memory_save for a generated card unless the user explicitly asks to remember or save it.",
    "Keep answers concise by default, and explain tool limits plainly when a requested tool is disabled.",
    "When a tool returns direxio.agent_action_result.v1, render a compact card: title, one-sentence summary, up to three bullets, and one next action. Do not paste raw JSON.",
    memoryBlock,
    evidenceBlock
  ].filter(Boolean).join("\n\n");
}

function directTaskPlan(): TaskPlan {
  return {
    mode: "direct",
    requiredCapabilities: [],
    reason: "Task control is disabled."
  };
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

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}
