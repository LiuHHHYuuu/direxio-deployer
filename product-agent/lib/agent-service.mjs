import { readJsonBody, sendJson } from "./http-json.mjs";

/**
 * Function: Creates the self-hosted product agent HTTP handler.
 * Inputs:
 * - options.gatewayUrl: Hosted AI gateway base URL. Defaults to DIREXIO_AI_GATEWAY_URL.
 * - options.aiToken: Direxio AI token for this self-hosted node. Defaults to DIREXIO_AI_TOKEN.
 * - options.fetchImpl: Fetch-compatible function for tests or custom runtimes.
 * Output:
 * - An async Node HTTP request handler.
 * Side effects:
 * - Reads JSON request bodies and may call the hosted AI gateway over HTTP.
 * Errors:
 * - Converts expected setup, gateway, quota, and provider failures into safe JSON responses.
 */
export function createAgentServiceHandler(options = {}) {
  const gatewayUrl = stripTrailingSlash(options.gatewayUrl || process.env.DIREXIO_AI_GATEWAY_URL || "http://127.0.0.1:8787");
  const aiToken = options.aiToken ?? process.env.DIREXIO_AI_TOKEN ?? "";
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  return async function agentServiceHandler(req, res) {
    if (req.method !== "POST" || req.url !== "/v1/agent/messages") {
      return sendJson(res, 404, { error: { code: "not_found", message: "Unknown product agent endpoint." } });
    }

    let event;
    try {
      event = await readJsonBody(req);
    } catch (error) {
      return sendJson(res, 400, { error: { code: "invalid_json", message: error.message } });
    }

    if (event?.conversation_type !== "direxio_ai") {
      return sendJson(res, 202, { ignored: true, reason: "not_ai_conversation" });
    }

    if (!aiToken) {
      return sendJson(res, 503, {
        error: {
          code: "setup_needed",
          message: "Direxio AI is not enabled for this node."
        }
      });
    }

    let payload;
    try {
      payload = buildGatewayChatPayload(event);
    } catch (error) {
      return sendJson(res, 400, { error: { code: "invalid_agent_event", message: error.message } });
    }

    const gatewayResponse = await callHostedGateway({ gatewayUrl, aiToken, payload, fetchImpl });
    if (!gatewayResponse.ok) {
      return sendJson(res, gatewayResponse.status, { error: gatewayResponse.error });
    }

    return sendJson(res, 200, {
      reply: gatewayResponse.reply,
      outbound_message: {
        conversation_id: payload.conversation_id,
        content: gatewayResponse.reply
      }
    });
  };
}

/**
 * Function: Builds the hosted gateway request from a product AI conversation event.
 * Inputs:
 * - event: Product conversation event with conversation_id, node_id, messages, and optional selected_context.
 * Output:
 * - A gateway chat payload containing only allowed context.
 * Side effects:
 * - None.
 * Errors:
 * - Throws when required event fields are missing or malformed.
 */
export function buildGatewayChatPayload(event) {
  const conversationId = requiredString(event.conversation_id, "conversation_id");
  const nodeId = stringOrDefault(event.node_id, "unknown-node");
  const messages = normalizeMessages(event.messages);

  const gatewayMessages = [];
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

/**
 * Function: Calls the hosted AI gateway and maps gateway failures to product-safe errors.
 * Inputs:
 * - gatewayUrl: Base URL of the hosted AI gateway.
 * - aiToken: Direxio AI token for Authorization.
 * - payload: Normalized chat payload.
 * - fetchImpl: Fetch-compatible function.
 * Output:
 * - Object with ok/reply on success or status/error on failure.
 * Side effects:
 * - Sends one HTTP request to the hosted gateway.
 * Errors:
 * - Network failures are converted to a temporary_unavailable response.
 */
export async function callHostedGateway({ gatewayUrl, aiToken, payload, fetchImpl = globalThis.fetch }) {
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
    if (typeof body.reply !== "string" || body.reply.length === 0) {
      return {
        ok: false,
        status: 502,
        error: {
          code: "bad_gateway_response",
          message: "Direxio AI returned an invalid response."
        }
      };
    }
    return { ok: true, reply: body.reply };
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

/**
 * Function: Maps hosted gateway HTTP failures to user-safe agent-service failures.
 * Inputs:
 * - status: HTTP status returned by ai-gateway.
 * - body: Parsed gateway response body when available.
 * Output:
 * - Object with ok=false, product HTTP status, and safe error code/message.
 * Side effects:
 * - None.
 * Errors:
 * - Does not throw.
 */
export function mapGatewayError(status, body = {}) {
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
      code: status >= 500 ? "temporary_unavailable" : body?.error?.code || "bad_gateway_request",
      message: status >= 500
        ? "Direxio AI is temporarily unavailable. Please try again later."
        : "Direxio AI could not process this request."
    }
  };
}

/**
 * Function: Normalizes product conversation messages into hosted gateway messages.
 * Inputs:
 * - messages: Array of message objects using role or sender plus content.
 * Output:
 * - Array of { role, content } objects accepted by ai-gateway.
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
    const content = requiredString(message.content, `messages[${index}].content`);
    const rawRole = message.role || message.sender || "user";
    const role = rawRole === "assistant" || rawRole === "agent" ? "assistant" : "user";
    return { role, content };
  });
}

/**
 * Function: Reads a required string field.
 * Inputs:
 * - value: Candidate value.
 * - name: Field name used in error messages.
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
 * Function: Converts an optional string to a fallback value.
 * Inputs:
 * - value: Candidate string.
 * - fallback: Value used when candidate is missing.
 * Output:
 * - Trimmed string or fallback.
 * Side effects:
 * - None.
 * Errors:
 * - Does not throw.
 */
function stringOrDefault(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/**
 * Function: Parses a fetch Response body as JSON without throwing to callers.
 * Inputs:
 * - response: Fetch Response object.
 * Output:
 * - Parsed JSON object or empty object.
 * Side effects:
 * - Reads the response body.
 * Errors:
 * - Invalid JSON is swallowed and represented as an empty object.
 */
async function safeResponseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

/**
 * Function: Removes trailing slashes from a base URL.
 * Inputs:
 * - value: URL string.
 * Output:
 * - URL without trailing slash characters.
 * Side effects:
 * - None.
 * Errors:
 * - Does not throw.
 */
function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}
