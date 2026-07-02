import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { GatewayChatRequest, GatewayMessage, ModelClient, TokenVerifier } from "./types.js";

export interface AiGatewayOptions {
  verifyToken?: TokenVerifier;
  modelClient?: ModelClient;
  logger?: boolean;
}

export class ModelProviderError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 502, code = "provider_error") {
    super(message);
    this.name = "ModelProviderError";
    this.status = status;
    this.code = code;
  }
}

export function createAiGatewayApp(options: AiGatewayOptions = {}): FastifyInstance {
  const verifyToken = options.verifyToken || createEnvTokenVerifier();
  const modelClient = options.modelClient || createEchoModelClient();

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
        message: "AI gateway failed unexpectedly."
      }
    });
  });

  app.post("/v1/chat", async (request, reply) => {
    const token = bearerToken(request.headers.authorization || "");
    if (!token || !(await verifyToken(token))) {
      return reply.status(401).send({
        error: {
          code: "invalid_token",
          message: "Invalid Direxio AI token."
        }
      });
    }

    let chat: GatewayChatRequest;
    try {
      chat = validateChatRequest(request.body);
    } catch (error) {
      return reply.status(400).send({
        error: {
          code: "invalid_chat_request",
          message: errorMessage(error)
        }
      });
    }

    try {
      const result = await modelClient(chat);
      return reply.status(200).send({
        reply: result.reply,
        request_id: result.request_id || randomUUID(),
        usage: result.usage || null
      });
    } catch (error) {
      const status = providerErrorStatus(error);
      const code = providerErrorCode(error, status);
      const message = status === 429 ? "AI quota exceeded." : "Model provider failed.";
      return reply.status(status).send({ error: { code, message } });
    }
  });

  return app;
}

export function validateChatRequest(body: unknown): GatewayChatRequest {
  const record = asRecord(body);
  const nodeId = requiredString(record.node_id, "node_id");
  const conversationId = requiredString(record.conversation_id, "conversation_id");
  const messages = normalizeMessages(record.messages);
  return {
    node_id: nodeId,
    conversation_id: conversationId,
    task: optionalString(record.task, "chat"),
    model: optionalString(record.model, "default"),
    messages
  };
}

export function createEnvTokenVerifier(env: NodeJS.ProcessEnv = process.env): TokenVerifier {
  const allowed = new Set(String(env.DIREXIO_AI_GATEWAY_TOKENS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean));
  return async function verifyEnvToken(token: string): Promise<boolean> {
    return allowed.size > 0 && allowed.has(token);
  };
}

export function createEchoModelClient(options: { prefix?: string } = {}): ModelClient {
  const prefix = options.prefix || "Direxio AI";
  return async function echoModelClient(chat: GatewayChatRequest) {
    const lastUser = [...chat.messages].reverse().find((message) => message.role === "user");
    return {
      reply: `${prefix}: ${lastUser?.content || "Hello."}`,
      usage: {
        input_messages: chat.messages.length
      }
    };
  };
}

export function createOpenAICompatibleClient(options: {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
} = {}): ModelClient {
  const baseUrl = stripTrailingSlash(options.baseUrl || process.env.DIREXIO_MODEL_BASE_URL || "https://api.openai.com/v1");
  const apiKey = options.apiKey || process.env.DIREXIO_MODEL_API_KEY || "";
  const model = options.model || process.env.DIREXIO_MODEL_NAME || "gpt-4.1-mini";
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  return async function openAICompatibleClient(chat: GatewayChatRequest) {
    if (!apiKey) {
      throw new ModelProviderError("model provider API key is missing", 502, "provider_not_configured");
    }
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages: chat.messages,
        temperature: 0.7
      })
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      throw new ModelProviderError(
        "model provider failed",
        response.status === 429 ? 429 : 502,
        response.status === 429 ? "quota_exceeded" : "provider_error"
      );
    }
    const choices = Array.isArray(body.choices) ? body.choices : [];
    const firstChoice = asRecord(choices[0]);
    const message = asRecord(firstChoice.message);
    const reply = message.content;
    if (typeof reply !== "string" || reply.length === 0) {
      throw new ModelProviderError("model provider returned no reply", 502, "provider_bad_response");
    }
    return {
      reply,
      usage: body.usage || null
    };
  };
}

export function bearerToken(authorization: string | string[]): string {
  const header = Array.isArray(authorization) ? authorization[0] || "" : authorization;
  const match = String(header || "").match(/^Bearer\s+(.+)$/i);
  return match?.[1] ? match[1].trim() : "";
}

function normalizeMessages(messages: unknown): GatewayMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("messages must be a non-empty array");
  }
  return messages.map((message, index) => {
    const item = asRecord(message);
    const rawRole = item.role;
    const role: GatewayMessage["role"] = rawRole === "assistant" || rawRole === "system" ? rawRole : "user";
    return {
      role,
      content: requiredString(item.content, `messages[${index}].content`)
    };
  });
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function providerErrorStatus(error: unknown): number {
  return error instanceof ModelProviderError ? error.status : 502;
}

function providerErrorCode(error: unknown, status: number): string {
  if (error instanceof ModelProviderError) {
    return error.code;
  }
  return status === 429 ? "quota_exceeded" : "provider_error";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Invalid AI gateway request.";
}

function errorStatusCode(error: unknown): number {
  const record = asRecord(error);
  return typeof record.statusCode === "number" ? record.statusCode : 500;
}

function stripTrailingSlash(value: string): string {
  return String(value).replace(/\/+$/, "");
}
