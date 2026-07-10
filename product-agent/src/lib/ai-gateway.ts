import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import {
  createTavilySearchProvider,
  SearchProviderError,
  type HostedSearchProvider
} from "./hosted-search.js";
import type {
  GatewayChatRequest,
  GatewayMessage,
  GatewayToolCall,
  GatewayToolDefinition,
  ModelClient,
  TokenVerifier
} from "./types.js";

export interface AiGatewayOptions {
  verifyToken?: TokenVerifier;
  modelClient?: ModelClient;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  logger?: boolean;
  searchProvider?: HostedSearchProvider;
}

export class ModelProviderError extends Error {
  readonly status: number;
  readonly code: string;
  readonly providerStatus?: number;
  readonly providerBody?: string;

  constructor(
    message: string,
    status = 502,
    code = "provider_error",
    providerDebug: { status?: number; body?: string } = {}
  ) {
    super(message);
    this.name = "ModelProviderError";
    this.status = status;
    this.code = code;
    this.providerStatus = providerDebug.status;
    this.providerBody = providerDebug.body;
  }
}

export function createAiGatewayApp(options: AiGatewayOptions = {}): FastifyInstance {
  const env = options.env || process.env;
  const verifyToken = options.verifyToken || createEnvTokenVerifier();
  const modelClient = options.modelClient || createDefaultModelClient({
    env,
    fetchImpl: options.fetchImpl
  });
  const searchProvider = options.searchProvider || createTavilySearchProvider({
    apiKey: env.TAVILY_API_KEY,
    endpoint: env.TAVILY_SEARCH_URL,
    fetchImpl: options.fetchImpl,
    timeoutMs: integerFromEnv(env.TAVILY_SEARCH_TIMEOUT_MS, 12000, 1000, 30000)
  });
  const searchLimiter = createFixedWindowLimiter({
    limit: integerFromEnv(env.DIREXIO_SEARCH_REQUESTS_PER_MINUTE, 60, 1, 10000),
    windowMs: 60000
  });
  const debugProvider = env.DIREXIO_AI_GATEWAY_DEBUG_PROVIDER === "1";

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
        tool_calls: result.tool_calls || [],
        request_id: result.request_id || randomUUID(),
        usage: result.usage || null
      });
    } catch (error) {
      const status = providerErrorStatus(error);
      const code = providerErrorCode(error, status);
      const message = status === 429 ? "AI quota exceeded." : "Model provider failed.";
      return reply.status(status).send({
        error: {
          code,
          message,
          ...(debugProvider ? providerDebugPayload(error) : {})
        }
      });
    }
  });

  app.post("/v1/tools/web-search", async (request, reply) => {
    const token = bearerToken(request.headers.authorization || "");
    if (!token || !(await verifyToken(token))) {
      return reply.status(401).send({
        error: {
          code: "invalid_token",
          message: "Invalid Direxio AI token."
        }
      });
    }
    if (!searchLimiter.allow(token)) {
      return reply.status(429).send({
        error: {
          code: "search_rate_limited",
          message: "Hosted search rate limit exceeded."
        }
      });
    }

    let query: string;
    try {
      query = validateSearchRequest(request.body);
    } catch (error) {
      return reply.status(400).send({
        error: {
          code: "invalid_search_request",
          message: errorMessage(error)
        }
      });
    }

    try {
      const result = await searchProvider(query);
      return reply.status(200).send({
        query: result.query,
        results: result.results,
        request_id: result.requestId || randomUUID()
      });
    } catch (error) {
      const status = error instanceof SearchProviderError ? error.status : 503;
      return reply.status(status).send({
        error: {
          code: error instanceof SearchProviderError ? error.code : "search_unavailable",
          message: status === 429 ? "Hosted search quota exceeded." : "Hosted search is temporarily unavailable."
        }
      });
    }
  });

  return app;
}

export function validateSearchRequest(body: unknown): string {
  const query = requiredString(asRecord(body).query, "query");
  if (query.length > 500) throw new Error("query must be at most 500 characters");
  return query;
}

export function validateChatRequest(body: unknown): GatewayChatRequest {
  const record = asRecord(body);
  const nodeId = requiredString(record.node_id, "node_id");
  const conversationId = requiredString(record.conversation_id, "conversation_id");
  const messages = normalizeMessages(record.messages);
  const tools = normalizeTools(record.tools);
  const toolChoice = normalizeToolChoice(record.tool_choice);
  return {
    node_id: nodeId,
    conversation_id: conversationId,
    task: optionalString(record.task, "chat"),
    model: optionalString(record.model, "default"),
    messages,
    ...(tools.length ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {})
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

export function createDefaultModelClient(options: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
} = {}): ModelClient {
  const env = options.env || process.env;
  const mode = env.DIREXIO_AI_GATEWAY_MODEL_MODE || "echo";
  if (mode === "openai-compatible") {
    return createOpenAICompatibleClient({
      baseUrl: env.DIREXIO_MODEL_BASE_URL,
      apiKey: env.DIREXIO_MODEL_API_KEY,
      model: env.DIREXIO_MODEL_NAME,
      fetchImpl: options.fetchImpl
    });
  }
  return createEchoModelClient();
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
        messages: chat.messages.map(toOpenAIMessage),
        temperature: 0.7,
        ...(chat.tools?.length ? { tools: chat.tools } : {}),
        ...(chat.tool_choice ? { tool_choice: chat.tool_choice } : {})
      })
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      throw new ModelProviderError(
        "model provider failed",
        response.status === 429 ? 429 : 502,
        response.status === 429 ? "quota_exceeded" : "provider_error",
        {
          status: response.status,
          body: sanitizeProviderBody(body)
        }
      );
    }
    const choices = Array.isArray(body.choices) ? body.choices : [];
    const firstChoice = asRecord(choices[0]);
    const message = asRecord(firstChoice.message);
    const reply = message.content;
    const toolCalls = normalizeProviderToolCalls(message.tool_calls);
    if ((typeof reply !== "string" || reply.length === 0) && toolCalls.length === 0) {
      throw new ModelProviderError("model provider returned no reply", 502, "provider_bad_response");
    }
    return {
      reply: typeof reply === "string" ? reply : "",
      tool_calls: toolCalls,
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
    const role: GatewayMessage["role"] =
      rawRole === "assistant" || rawRole === "system" || rawRole === "tool" ? rawRole : "user";
    const toolCalls = normalizeToolCalls(item.tool_calls, `messages[${index}].tool_calls`);
    const toolCallId = optionalString(item.tool_call_id, "");
    if (role === "tool" && !toolCallId) {
      throw new Error(`messages[${index}].tool_call_id must be provided for tool messages`);
    }
    return {
      role,
      content: messageContent(item.content, `messages[${index}].content`, role === "assistant" && toolCalls.length > 0),
      ...(toolCallId ? { tool_call_id: toolCallId } : {}),
      ...(typeof item.name === "string" && item.name.trim() ? { name: item.name.trim() } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {})
    };
  });
}

function normalizeTools(tools: unknown): GatewayToolDefinition[] {
  if (tools === undefined) return [];
  if (!Array.isArray(tools)) {
    throw new Error("tools must be an array when provided");
  }
  return tools.map((toolDefinition, index) => {
    const item = asRecord(toolDefinition);
    const functionDefinition = asRecord(item.function);
    return {
      type: "function" as const,
      function: {
        name: requiredString(functionDefinition.name, `tools[${index}].function.name`),
        ...(typeof functionDefinition.description === "string" && functionDefinition.description.trim()
          ? { description: functionDefinition.description.trim() }
          : {}),
        parameters: asRecord(functionDefinition.parameters)
      }
    };
  });
}

function normalizeToolChoice(value: unknown): "auto" | "none" | undefined {
  return value === "auto" || value === "none" ? value : undefined;
}

function normalizeToolCalls(value: unknown, name: string): GatewayToolCall[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array when provided`);
  }
  return value.map((toolCall, index) => {
    const item = asRecord(toolCall);
    return {
      id: requiredString(item.id, `${name}[${index}].id`),
      name: requiredString(item.name, `${name}[${index}].name`),
      args: asRecord(item.args),
      type: "tool_call" as const
    };
  });
}

function normalizeProviderToolCalls(value: unknown): GatewayToolCall[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((toolCall) => {
      const item = asRecord(toolCall);
      const functionCall = asRecord(item.function);
      const name = typeof functionCall.name === "string" ? functionCall.name.trim() : "";
      if (!name) return null;
      return {
        id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : randomUUID(),
        name,
        args: parseToolArguments(functionCall.arguments),
        type: "tool_call" as const
      };
    })
    .filter((toolCall): toolCall is GatewayToolCall => Boolean(toolCall));
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

function toOpenAIMessage(message: GatewayMessage): Record<string, unknown> {
  const openAIMessage: Record<string, unknown> = {
    role: message.role,
    content: message.content
  };
  if (message.name) {
    openAIMessage.name = message.name;
  }
  if (message.role === "tool" && message.tool_call_id) {
    openAIMessage.tool_call_id = message.tool_call_id;
  }
  if (message.tool_calls?.length) {
    openAIMessage.tool_calls = message.tool_calls.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.args || {})
      }
    }));
  }
  return openAIMessage;
}

function messageContent(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string") {
    if (allowEmpty && value === undefined) return "";
    throw new Error(`${name} must be a string`);
  }
  if (!allowEmpty && value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return allowEmpty ? value : value.trim();
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

function providerDebugPayload(error: unknown): Record<string, unknown> {
  if (!(error instanceof ModelProviderError)) {
    return {};
  }
  return {
    provider_status: error.providerStatus || error.status,
    provider_body: error.providerBody || ""
  };
}

function sanitizeProviderBody(body: unknown): string {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.replace(/sk-[A-Za-z0-9_-]+/g, "sk-***").slice(0, 1200);
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

function integerFromEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

function createFixedWindowLimiter(options: { limit: number; windowMs: number }) {
  const buckets = new Map<string, { startedAt: number; count: number }>();
  return {
    allow(key: string): boolean {
      const now = Date.now();
      const bucket = buckets.get(key);
      if (!bucket || now - bucket.startedAt >= options.windowMs) {
        buckets.set(key, { startedAt: now, count: 1 });
        return true;
      }
      if (bucket.count >= options.limit) return false;
      bucket.count += 1;
      return true;
    }
  };
}

function stripTrailingSlash(value: string): string {
  return String(value).replace(/\/+$/, "");
}
