import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import {
  agentActionToMessageContent,
  normalizeAgentAction
} from "./abilities/action-protocol.js";
import { createAgentActionMenu } from "./abilities/official-experience-abilities.js";
import { toAgentMessageEvent, type MessageServerNewMessageEvent } from "./message-server-adapter.js";
import { createAgentRuntime } from "./runtime/index.js";
import type { AgentRuntime } from "./runtime/types.js";
import type { FetchLike, GatewayChatRequest, GatewayMessage } from "./types.js";

export interface AgentServiceOptions {
  gatewayUrl?: string;
  aiToken?: string;
  fetchImpl?: FetchLike;
  runtime?: AgentRuntime;
  logger?: boolean;
}

export function createAgentServiceApp(options: AgentServiceOptions = {}): FastifyInstance {
  const gatewayUrl = stripTrailingSlash(options.gatewayUrl || process.env.DIREXIO_AI_GATEWAY_URL || "http://127.0.0.1:8787");
  const aiToken = options.aiToken ?? process.env.DIREXIO_AI_TOKEN ?? "";
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const runtime = options.runtime || createAgentRuntime({ fetchImpl });

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

  app.post("/v1/agent/messages", async (request, reply) => {
    const event = asRecord(request.body);

    return handleAgentMessageEvent({
      event,
      aiToken,
      gatewayUrl,
      fetchImpl,
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
  runtime,
  reply
}: {
  event: Record<string, unknown>;
  aiToken: string;
  gatewayUrl: string;
  fetchImpl: FetchLike;
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
      content: gatewayResponse.reply
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

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
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

function stripTrailingSlash(value: string): string {
  return String(value).replace(/\/+$/, "");
}
