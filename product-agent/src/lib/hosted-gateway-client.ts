import type { FetchLike, GatewayChatRequest, GatewayToolCall } from "./types.js";

export interface HostedGatewaySuccess {
  ok: true;
  reply: string;
  tool_calls?: GatewayToolCall[];
}

export interface HostedGatewayFailure {
  ok: false;
  status: number;
  error: {
    code: string;
    message: string;
  };
}

export type HostedGatewayResult = HostedGatewaySuccess | HostedGatewayFailure;

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
    const toolCalls = normalizeToolCalls(responseBody.tool_calls);
    if (typeof responseBody.reply !== "string" || (responseBody.reply.length === 0 && toolCalls.length === 0)) {
      return {
        ok: false,
        status: 502,
        error: {
          code: "bad_gateway_response",
          message: "Direxio AI returned an invalid response."
        }
      };
    }
    return {
      ok: true,
      reply: responseBody.reply,
      tool_calls: toolCalls
    };
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

async function safeResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function gatewayErrorCode(body: unknown): string {
  const bodyRecord = asRecord(body);
  const errorRecord = asRecord(bodyRecord.error);
  return typeof errorRecord.code === "string" ? errorRecord.code : "";
}

function normalizeToolCalls(value: unknown): GatewayToolCall[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const id = typeof record.id === "string" ? record.id : "";
      const name = typeof record.name === "string" ? record.name : "";
      const args = asRecord(record.args);
      if (!id || !name) return null;
      return { id, name, args, type: "tool_call" as const };
    })
    .filter((item): item is GatewayToolCall => Boolean(item));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function stripTrailingSlash(value: string): string {
  return String(value).replace(/\/+$/, "");
}
