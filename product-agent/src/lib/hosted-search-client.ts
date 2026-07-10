import type { HostedSearchResponse } from "./hosted-search.js";
import type { FetchLike } from "./types.js";

export type HostedSearchClientResult =
  | { ok: true; response: HostedSearchResponse }
  | { ok: false; status: number; code: string };

export async function callHostedSearch(options: {
  gatewayUrl: string;
  aiToken: string;
  query: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<HostedSearchClientResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
  try {
    const response = await (options.fetchImpl || globalThis.fetch)(
      `${stripTrailingSlash(options.gatewayUrl)}/v1/tools/web-search`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${options.aiToken}`,
          "Content-Type": "application/json"
        },
        signal: controller.signal,
        body: JSON.stringify({ query: options.query })
      }
    );
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      return { ok: false, status: response.status, code: errorCode(body) || "hosted_search_failed" };
    }
    return { ok: true, response: normalizeHostedResponse(body, options.query) };
  } catch (error) {
    return {
      ok: false,
      status: isAbortError(error) ? 504 : 503,
      code: isAbortError(error) ? "hosted_search_timeout" : "hosted_search_unavailable"
    };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeHostedResponse(body: Record<string, unknown>, fallbackQuery: string): HostedSearchResponse {
  const rawResults = Array.isArray(body.results) ? body.results : [];
  return {
    query: stringField(body.query) || fallbackQuery,
    results: rawResults.map((item) => {
      const record = asRecord(item);
      return {
        title: stringField(record.title),
        url: stringField(record.url),
        snippet: stringField(record.snippet),
        ...(stringField(record.publishedAt) ? { publishedAt: stringField(record.publishedAt) } : {})
      };
    }).filter((item) => item.title && item.url && item.snippet).slice(0, 5),
    ...(stringField(body.request_id || body.requestId) ? { requestId: stringField(body.request_id || body.requestId) } : {})
  };
}

function errorCode(body: Record<string, unknown>): string {
  return stringField(asRecord(body.error).code);
}

function isAbortError(error: unknown): boolean {
  const record = asRecord(error);
  return error instanceof DOMException && error.name === "AbortError" ||
    record.name === "AbortError" || record.code === "ABORT_ERR";
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function stripTrailingSlash(value: string): string {
  return String(value).replace(/\/+$/, "");
}
