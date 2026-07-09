import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import {
  agentActionToMessageContent,
  normalizeAgentAction
} from "./abilities/action-protocol.js";
import { createAgentActionMenu } from "./abilities/official-experience-abilities.js";
import { createDefaultThreadMemoryStore } from "./memory/store-factory.js";
import type {
  AgentMemoryItemSource,
  AgentMemoryItemType,
  ThreadMemoryStore
} from "./memory/thread-memory.js";
import { toAgentMessageEvent, type MessageServerNewMessageEvent } from "./message-server-adapter.js";
import { createAgentRuntime } from "./runtime/index.js";
import type { AgentRuntime } from "./runtime/types.js";
import {
  createDefaultPromptSkillStore,
  PromptSkillValidationError,
  type PromptSkillStore
} from "./skills/prompt-skill-store.js";
import type { PromptSkillDefinition } from "./skills/prompt-skill.js";
import { syncPromptSkillsFromConfig } from "./skills/prompt-skill-sync.js";
import { createAgentToolRegistry } from "./tools/registry.js";
import type { FetchLike, GatewayChatRequest, GatewayMessage } from "./types.js";

export interface AgentServiceOptions {
  gatewayUrl?: string;
  aiToken?: string;
  fetchImpl?: FetchLike;
  runtime?: AgentRuntime;
  memoryStore?: ThreadMemoryStore;
  promptSkillStore?: PromptSkillStore;
  env?: NodeJS.ProcessEnv;
  logger?: boolean;
}

export function createAgentServiceApp(options: AgentServiceOptions = {}): FastifyInstance {
  const env = options.env || process.env;
  const gatewayUrl = stripTrailingSlash(options.gatewayUrl || env.DIREXIO_AI_GATEWAY_URL || "http://127.0.0.1:8787");
  const aiToken = options.aiToken ?? env.DIREXIO_AI_TOKEN ?? "";
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const memoryStore = options.memoryStore || createDefaultThreadMemoryStore(env);
  const promptSkillStore = options.promptSkillStore || createDefaultPromptSkillStore(env);
  const runtime = options.runtime || createAgentRuntime({ fetchImpl, env, memoryStore, promptSkillStore });

  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 1024 * 1024
  });

  app.setErrorHandler((error, _request, reply) => {
    if (errorStatusCode(error) === 400) {
      return reply.status(400).send({
        error: {
          code: "invalid_json",
          message: "request body must be valid JSON"
        }
      });
    }
    return reply.status(500).send({
      error: {
        code: "internal_error",
        message: "Product agent failed unexpectedly."
      }
    });
  });

  app.get("/v1/agent/actions", async (_request, reply) => {
    return reply.status(200).send(createAgentActionMenu());
  });

  app.get("/v1/agent/tools", async (_request, reply) => {
    return reply.status(200).send({
      schema: "direxio.agent_tools.v1",
      title: "Direxio AI tools",
      items: createAgentToolRegistry({ promptSkillStore }).manifests
    });
  });

  app.get("/v1/agent/memory", async (request, reply) => {
    const query = asRecord(request.query);
    try {
      const conversationId = requiredString(query.conversation_id, "conversation_id");
      return reply.status(200).send({
        schema: "direxio.agent_memory_list.v1",
        items: memoryStore.listMemories(conversationId)
      });
    } catch (error) {
      return invalidAgentRequest(reply, errorMessage(error));
    }
  });

  app.post("/v1/agent/memory", async (request, reply) => {
    const body = asRecord(request.body);
    try {
      const conversationId = requiredString(body.conversation_id, "conversation_id");
      const text = requiredString(body.text, "text");
      const item = memoryStore.saveMemory(conversationId, {
        text,
        type: optionalMemoryItemType(body.type),
        tags: stringList(body.tags),
        source: optionalMemoryItemSource(body.source)
      });
      return reply.status(201).send({
        schema: "direxio.agent_memory_item.v1",
        item
      });
    } catch (error) {
      return invalidAgentRequest(reply, errorMessage(error));
    }
  });

  app.delete("/v1/agent/memory/:id", async (request, reply) => {
    const params = asRecord(request.params);
    const query = asRecord(request.query);
    try {
      const id = requiredString(params.id, "id");
      const conversationId = requiredString(query.conversation_id, "conversation_id");
      return reply.status(200).send({
        schema: "direxio.agent_memory_delete.v1",
        id,
        deleted: memoryStore.deleteMemory(conversationId, id)
      });
    } catch (error) {
      return invalidAgentRequest(reply, errorMessage(error));
    }
  });

  app.get("/v1/agent/skills", async (_request, reply) => {
    return reply.status(200).send({
      schema: "direxio.prompt_skill_list.v1",
      items: promptSkillStore.listSkills()
    });
  });

  app.post("/v1/agent/skills/validate", async (request, reply) => {
    const result = promptSkillStore.validateSkill(request.body);
    return reply.status(200).send({
      schema: "direxio.prompt_skill_validation.v1",
      ok: result.ok,
      errors: result.errors,
      ...(result.skill ? { skill: result.skill } : {})
    });
  });

  app.post("/v1/agent/skills", async (request, reply) => {
    try {
      const skill = promptSkillStore.saveSkill(request.body);
      return reply.status(201).send({
        schema: "direxio.prompt_skill_item.v1",
        item: skill
      });
    } catch (error) {
      if (error instanceof PromptSkillValidationError) {
        return reply.status(400).send({
          error: {
            code: "invalid_prompt_skill",
            message: error.message,
            errors: error.errors
          }
        });
      }
      throw error;
    }
  });

  app.post("/v1/agent/skills/sync", async (request, reply) => {
    const result = syncPromptSkillsFromConfig(promptSkillStore, request.body);
    const body = {
      schema: "direxio.prompt_skill_sync.v1",
      saved: result.saved,
      skipped: result.skipped,
      errors: result.errors
    };
    return reply.status(result.errors.length ? 400 : 200).send(body);
  });

  app.patch("/v1/agent/skills/:id", async (request, reply) => {
    const params = asRecord(request.params);
    try {
      const id = requiredString(params.id, "id");
      const existing = promptSkillStore.listSkills().find((skill) => skill.id === id);
      if (!existing) {
        return reply.status(404).send({
          error: {
            code: "prompt_skill_not_found",
            message: `Prompt Skill ${id} was not found.`
          }
        });
      }
      const skill = promptSkillStore.saveSkill(mergePromptSkillPatch(id, existing, request.body));
      return reply.status(200).send({
        schema: "direxio.prompt_skill_item.v1",
        item: skill
      });
    } catch (error) {
      if (error instanceof PromptSkillValidationError) {
        return reply.status(400).send({
          error: {
            code: "invalid_prompt_skill",
            message: error.message,
            errors: error.errors
          }
        });
      }
      return invalidAgentRequest(reply, errorMessage(error));
    }
  });

  app.delete("/v1/agent/skills/:id", async (request, reply) => {
    const params = asRecord(request.params);
    try {
      const id = requiredString(params.id, "id");
      return reply.status(200).send({
        schema: "direxio.prompt_skill_delete.v1",
        id,
        deleted: promptSkillStore.deleteSkill(id)
      });
    } catch (error) {
      return invalidAgentRequest(reply, errorMessage(error));
    }
  });

  app.post("/v1/agent/messages", async (request, reply) => {
    const event = asRecord(request.body);

    return handleAgentMessageEvent({
      event,
      aiToken,
      gatewayUrl,
      fetchImpl,
      promptSkillStore,
      runtime,
      reply
    });
  });

  app.post("/v1/message-server/new-message", async (request, reply) => {
    const adapted = toAgentMessageEvent(request.body as MessageServerNewMessageEvent);
    if ("ignored" in adapted) {
      return reply.status(202).send(adapted);
    }

    return handleAgentMessageEvent({
      event: adapted as unknown as Record<string, unknown>,
      aiToken,
      gatewayUrl,
      fetchImpl,
      promptSkillStore,
      runtime,
      reply
    });
  });

  return app;
}

async function handleAgentMessageEvent({
  event,
  aiToken,
  gatewayUrl,
  fetchImpl,
  promptSkillStore,
  runtime,
  reply
}: {
  event: Record<string, unknown>;
  aiToken: string;
  gatewayUrl: string;
  fetchImpl: FetchLike;
  promptSkillStore: PromptSkillStore;
  runtime: AgentRuntime;
  reply: FastifyReply;
}) {
  if (event.conversation_type !== "direxio_ai") {
    return reply.status(202).send({ ignored: true, reason: "not_ai_conversation" });
  }

  if (!aiToken) {
    return reply.status(503).send({
      error: {
        code: "setup_needed",
        message: "Direxio AI is not enabled for this node."
      }
    });
  }

  let payload: GatewayChatRequest;
  try {
    syncPromptSkillsFromConfig(promptSkillStore, event);
    payload = buildGatewayChatPayload(event);
  } catch (error) {
    return reply.status(400).send({
      error: {
        code: "invalid_agent_event",
        message: errorMessage(error)
      }
    });
  }

  const gatewayResponse = await runtime.run({ event, payload, gatewayUrl, aiToken, fetchImpl });
  if (!gatewayResponse.ok) {
    return reply.status(gatewayResponse.status).send({ error: gatewayResponse.error });
  }

  return reply.status(200).send({
    reply: gatewayResponse.reply,
    outbound_message: {
      conversation_id: payload.conversation_id,
      content: "outboundContent" in gatewayResponse
        ? gatewayResponse.outboundContent
        : gatewayResponse.reply
    }
  });
}

export function buildGatewayChatPayload(event: Record<string, unknown>): GatewayChatRequest {
  const conversationId = requiredString(event.conversation_id, "conversation_id");
  const nodeId = stringOrDefault(event.node_id, "unknown-node");
  const messages = normalizeMessages(event.messages, event.agent_action);

  const gatewayMessages: GatewayMessage[] = [];
  if (event.context_authorized === true && typeof event.selected_context === "string" && event.selected_context.trim()) {
    gatewayMessages.push({
      role: "user",
      content: `Selected context:\n${event.selected_context.trim()}`
    });
  }
  gatewayMessages.push(...messages);

  return {
    node_id: nodeId,
    conversation_id: conversationId,
    task: stringOrDefault(event.task, "chat"),
    model: stringOrDefault(event.model, "default"),
    messages: gatewayMessages
  };
}

function normalizeMessages(messages: unknown, agentAction?: unknown): GatewayMessage[] {
  const normalizedAgentAction = normalizeAgentAction(agentAction);
  if (!Array.isArray(messages) || messages.length === 0) {
    if (normalizedAgentAction) {
      return [{ role: "user", content: agentActionToMessageContent(normalizedAgentAction) }];
    }
    throw new Error("messages must be a non-empty array");
  }
  const normalized = messages.map((message, index) => {
    const item = asRecord(message);
    const actionContent = actionMessageContent(item);
    if (actionContent) {
      return { role: "user" as const, content: actionContent };
    }
    const content = requiredString(item.content, `messages[${index}].content`);
    const rawRole = item.role || item.sender || "user";
    const role: GatewayMessage["role"] = rawRole === "assistant" || rawRole === "agent" ? "assistant" : "user";
    return { role, content };
  });
  return normalizedAgentAction
    ? [...normalized, { role: "user", content: agentActionToMessageContent(normalizedAgentAction) }]
    : normalized;
}

function actionMessageContent(item: Record<string, unknown>): string {
  const action = normalizeAgentAction(item);
  return action ? agentActionToMessageContent(action) : "";
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function optionalMemoryItemType(value: unknown): AgentMemoryItemType | undefined {
  return value === "preference" ||
    value === "fact" ||
    value === "card_memory" ||
    value === "skill_result" ||
    value === "thread_summary"
    ? value
    : undefined;
}

function optionalMemoryItemSource(value: unknown): AgentMemoryItemSource | undefined {
  return value === "user_explicit" ||
    value === "agent_card_save" ||
    value === "prompt_skill" ||
    value === "migration" ||
    value === "auto_compression"
    ? value
    : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/**
 * Function: Builds a full Prompt Skill save body from an existing skill and a PATCH request.
 * Inputs:
 * - id: Route id that owns the update and prevents accidental id changes.
 * - existing: Current persisted Prompt Skill.
 * - patch: Partial update body from the HTTP request, accepting camelCase or snake_case fields.
 * Output:
 * - Full Prompt Skill-shaped object ready for the normal store validator.
 * Side effects:
 * - None; persistence still happens through `promptSkillStore.saveSkill`.
 * Errors:
 * - None here; invalid merged values are rejected by the existing validator.
 */
function mergePromptSkillPatch(
  id: string,
  existing: PromptSkillDefinition,
  patch: unknown
): Record<string, unknown> {
  const record = asRecord(patch);
  const merged: Record<string, unknown> = {
    ...existing,
    ...record,
    id,
    schema: existing.schema,
    createdAt: existing.createdAt
  };
  if (Object.hasOwn(record, "trigger_examples")) {
    merged.triggerExamples = record.trigger_examples;
  }
  if (Object.hasOwn(record, "output_kind")) {
    merged.outputKind = record.output_kind;
  }
  return merged;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Invalid product agent event.";
}

function errorStatusCode(error: unknown): number {
  const record = asRecord(error);
  return typeof record.statusCode === "number" ? record.statusCode : 500;
}

function invalidAgentRequest(reply: FastifyReply, message: string) {
  return reply.status(400).send({
    error: {
      code: "invalid_agent_request",
      message
    }
  });
}

function stripTrailingSlash(value: string): string {
  return String(value).replace(/\/+$/, "");
}
