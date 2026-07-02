import { randomUUID } from "node:crypto";
import { readJsonBody, sendJson } from "./http-json.mjs";

/**
 * Function: Creates the hosted AI gateway HTTP handler.
 * Inputs:
 * - options.verifyToken: Function that validates Direxio AI bearer tokens.
 * - options.modelClient: Function that turns normalized chat payloads into replies.
 * Output:
 * - An async Node HTTP request handler for POST /v1/chat.
 * Side effects:
 * - Reads request bodies and may call a model provider through modelClient.
 * Errors:
 * - Converts authentication, validation, quota, and model failures into JSON responses.
 */
export function createAiGatewayHandler(options = {}) {
  const verifyToken = options.verifyToken || createEnvTokenVerifier();
  const modelClient = options.modelClient || createEchoModelClient();

  return async function aiGatewayHandler(req, res) {
    if (req.method !== "POST" || req.url !== "/v1/chat") {
      return sendJson(res, 404, { error: { code: "not_found", message: "Unknown AI gateway endpoint." } });
    }

    const token = bearerToken(req.headers.authorization || "");
    if (!token || !(await verifyToken(token))) {
      return sendJson(res, 401, { error: { code: "invalid_token", message: "Invalid Direxio AI token." } });
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return sendJson(res, 400, { error: { code: "invalid_json", message: error.message } });
    }

    let chat;
    try {
      chat = validateChatRequest(body);
    } catch (error) {
      return sendJson(res, 400, { error: { code: "invalid_chat_request", message: error.message } });
    }

    try {
      const result = await modelClient(chat);
      return sendJson(res, 200, {
        reply: result.reply,
        request_id: result.request_id || randomUUID(),
        usage: result.usage || null
      });
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 502;
      const code = error.code || (status === 429 ? "quota_exceeded" : "provider_error");
      const message = status === 429 ? "AI quota exceeded." : "Model provider failed.";
      return sendJson(res, status, { error: { code, message } });
    }
  };
}

/**
 * Function: Validates and normalizes a hosted chat request.
 * Inputs:
 * - body: Parsed JSON request body from agent-service.
 * Output:
 * - Normalized chat object with node_id, conversation_id, task, model, and messages.
 * Side effects:
 * - None.
 * Errors:
 * - Throws when required fields are missing or malformed.
 */
export function validateChatRequest(body) {
  const nodeId = requiredString(body?.node_id, "node_id");
  const conversationId = requiredString(body?.conversation_id, "conversation_id");
  const messages = normalizeMessages(body?.messages);
  return {
    node_id: nodeId,
    conversation_id: conversationId,
    task: optionalString(body?.task, "chat"),
    model: optionalString(body?.model, "default"),
    messages
  };
}

/**
 * Function: Creates a token verifier backed by DIREXIO_AI_GATEWAY_TOKENS.
 * Inputs:
 * - env: Environment object; defaults to process.env.
 * Output:
 * - Async function that returns true when a token is configured and allowed.
 * Side effects:
 * - Reads environment values at creation time.
 * Errors:
 * - Does not throw.
 */
export function createEnvTokenVerifier(env = process.env) {
  const allowed = new Set(String(env.DIREXIO_AI_GATEWAY_TOKENS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean));
  return async function verifyEnvToken(token) {
    return allowed.size > 0 && allowed.has(token);
  };
}

/**
 * Function: Creates a deterministic model client for local development and tests.
 * Inputs:
 * - options.prefix: Optional prefix for the generated reply.
 * Output:
 * - Async function compatible with ai-gateway modelClient.
 * Side effects:
 * - None.
 * Errors:
 * - Does not throw.
 */
export function createEchoModelClient(options = {}) {
  const prefix = options.prefix || "Direxio AI";
  return async function echoModelClient(chat) {
    const lastUser = [...chat.messages].reverse().find((message) => message.role === "user");
    return {
      reply: `${prefix}: ${lastUser?.content || "Hello."}`,
      usage: {
        input_messages: chat.messages.length
      }
    };
  };
}

/**
 * Function: Creates an OpenAI-compatible model client for hosted gateway deployments.
 * Inputs:
 * - options.baseUrl: OpenAI-compatible API base URL.
 * - options.apiKey: Provider API key stored only by ai-gateway.
 * - options.model: Provider model name.
 * - options.fetchImpl: Fetch-compatible function.
 * Output:
 * - Async function compatible with ai-gateway modelClient.
 * Side effects:
 * - Sends HTTPS requests to the configured provider.
 * Errors:
 * - Throws provider_error or quota_exceeded style errors for upstream failures.
 */
export function createOpenAICompatibleClient(options = {}) {
  const baseUrl = stripTrailingSlash(options.baseUrl || process.env.DIREXIO_MODEL_BASE_URL || "https://api.openai.com/v1");
  const apiKey = options.apiKey || process.env.DIREXIO_MODEL_API_KEY || "";
  const model = options.model || process.env.DIREXIO_MODEL_NAME || "gpt-4.1-mini";
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  return async function openAICompatibleClient(chat) {
    if (!apiKey) {
      const error = new Error("model provider API key is missing");
      error.status = 502;
      error.code = "provider_not_configured";
      throw error;
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
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error("model provider failed");
      error.status = response.status === 429 ? 429 : 502;
      error.code = response.status === 429 ? "quota_exceeded" : "provider_error";
      throw error;
    }
    const reply = body?.choices?.[0]?.message?.content;
    if (typeof reply !== "string" || reply.length === 0) {
      const error = new Error("model provider returned no reply");
      error.status = 502;
      error.code = "provider_bad_response";
      throw error;
    }
    return {
      reply,
      usage: body.usage || null
    };
  };
}

/**
 * Function: Extracts a bearer token from an Authorization header.
 * Inputs:
 * - authorization: Raw Authorization header value.
 * Output:
 * - Token string or empty string.
 * Side effects:
 * - None.
 * Errors:
 * - Does not throw.
 */
export function bearerToken(authorization) {
  const match = String(authorization || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

/**
 * Function: Normalizes hosted gateway messages.
 * Inputs:
 * - messages: Candidate messages array.
 * Output:
 * - Array of role/content messages.
 * Side effects:
 * - None.
 * Errors:
 * - Throws when messages are missing, empty, or malformed.
 */
function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("messages must be a non-empty array");
  }
  return messages.map((message, index) => {
    const role = message?.role === "assistant" || message?.role === "system" ? message.role : "user";
    return {
      role,
      content: requiredString(message?.content, `messages[${index}].content`)
    };
  });
}

/**
 * Function: Reads a required string field.
 * Inputs:
 * - value: Candidate value.
 * - name: Field name used in errors.
 * Output:
 * - Trimmed non-empty string.
 * Side effects:
 * - None.
 * Errors:
 * - Throws when value is not a non-empty string.
 */
function requiredString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Function: Reads an optional string field with fallback.
 * Inputs:
 * - value: Candidate value.
 * - fallback: Fallback string.
 * Output:
 * - Trimmed string or fallback.
 * Side effects:
 * - None.
 * Errors:
 * - Does not throw.
 */
function optionalString(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/**
 * Function: Removes trailing slash characters from a URL.
 * Inputs:
 * - value: URL string.
 * Output:
 * - URL without trailing slashes.
 * Side effects:
 * - None.
 * Errors:
 * - Does not throw.
 */
function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}
