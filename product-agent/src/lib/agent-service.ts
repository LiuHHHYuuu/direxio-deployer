import Fastify, { type FastifyInstance } from "fastify";
import type { FetchLike, GatewayChatRequest, GatewayMessage } from "./types.js";

export interface AgentServiceOptions {
  gatewayUrl?: string;
  aiToken?: string;
  fetchImpl?: FetchLike;
  logger?: boolean;
}

interface HostedGatewaySuccess {
  ok: true;
  reply: string;
}

interface HostedGatewayFailure {
  ok: false;
  status: number;
  error: {
    code: string;
    message: string;
  };
}

type HostedGatewayResult = HostedGatewaySuccess | HostedGatewayFailure;

export function createAgentServiceApp(options: AgentServiceOptions = {}): FastifyInstance {
  const gatewayUrl = stripTrailingSlash(options.gatewayUrl || process.env.DIREXIO_AI_GATEWAY_URL || "http://127.0.0.1:8787");
  const aiToken = options.aiToken ?? process.env.DIREXIO_AI_TOKEN ?? "";
  const fetchImpl = options.fetchImpl || globalThis.fetch;

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

  app.post("/v1/agent/messages", async (request, reply) => {
    const event = asRecord(request.body);

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

    const gatewayResponse = await callHostedGateway({ gatewayUrl, aiToken, payload, fetchImpl });
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
  });

  return app;
}

export function buildGatewayChatPayload(event: Record<string, unknown>): GatewayChatRequest {
  const conversationId = requiredString(event.conversation_id, "conversation_id");
  const nodeId = stringOrDefault(event.node_id, "unknown-node");
  const messages = normalizeMessages(event.messages);

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

export async function callHostedGateway({
  gatewayUrl,
  aiToken,
  payload,
  fetchImpl = globalThis.fetch
}: {
  gatewayUrl: string;
  aiToken: string;
  payload: GatewayChatRequest;
  fetchImpl?: FetchLike;
}): Promise<HostedGatewayResult> {
  try {
    const response = await fetchImpl(`${stripTrailingSlash(gatewayUrl)}/v1/chat`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${aiToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const body = await safeResponseJson(response);
    if (!response.ok) {
      return mapGatewayError(response.status, body);
    }
    const responseBody = asRecord(body);
    if (typeof responseBody.reply !== "string" || responseBody.reply.length === 0) {
      return {
        ok: false,
        status: 502,
        error: {
          code: "bad_gateway_response",
          message: "Direxio AI returned an invalid response."
        }
      };
    }
    return { ok: true, reply: responseBody.reply };
  } catch {
    return {
      ok: false,
      status: 503,
      error: {
        code: "temporary_unavailable",
        message: "Direxio AI is temporarily unavailable. Please try again later."
      }
    };
  }
}

export function mapGatewayError(status: number, body: unknown = {}): HostedGatewayFailure {
  if (status === 401 || status === 403) {
    return {
      ok: false,
      status: 503,
      error: {
        code: "hosted_ai_auth_failed",
        message: "Direxio AI authentication failed. Ask the owner to refresh the AI token."
      }
    };
  }
  if (status === 429) {
    return {
      ok: false,
      status: 429,
      error: {
        code: "quota_exceeded",
        message: "Direxio AI quota is used up for this node."
      }
    };
  }
  return {
    ok: false,
    status: status >= 500 ? 503 : 400,
    error: {
      code: status >= 500 ? "temporary_unavailable" : gatewayErrorCode(body) || "bad_gateway_request",
      message: status >= 500
        ? "Direxio AI is temporarily unavailable. Please try again later."
        : "Direxio AI could not process this request."
    }
  };
}

function normalizeMessages(messages: unknown): GatewayMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("messages must be a non-empty array");
  }
  return messages.map((message, index) => {
    const item = asRecord(message);
    const content = requiredString(item.content, `messages[${index}].content`);
    const rawRole = item.role || item.sender || "user";
    const role: GatewayMessage["role"] = rawRole === "assistant" || rawRole === "agent" ? "assistant" : "user";
    return { role, content };
  });
}

function gatewayErrorCode(body: unknown): string {
  const bodyRecord = asRecord(body);
  const errorRecord = asRecord(bodyRecord.error);
  return typeof errorRecord.code === "string" ? errorRecord.code : "";
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

async function safeResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
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
