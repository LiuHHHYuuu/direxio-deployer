import type { FetchLike } from "./types.js";

export interface HostedSearchResultItem {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface HostedSearchResponse {
  query: string;
  results: HostedSearchResultItem[];
  requestId?: string;
}

export type HostedSearchProvider = (query: string) => Promise<HostedSearchResponse>;

export class SearchProviderError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "SearchProviderError";
  }
}

export function createTavilySearchProvider(options: {
  apiKey?: string;
  endpoint?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
} = {}): HostedSearchProvider {
  const apiKey = options.apiKey || process.env.TAVILY_API_KEY || "";
  const endpoint = options.endpoint || process.env.TAVILY_SEARCH_URL || "https://api.tavily.com/search";
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = boundedInteger(options.timeoutMs, 12000, 1000, 30000);

  return async (query: string) => {
    if (!apiKey) {
      throw new SearchProviderError(503, "search_not_configured", "Hosted search is not configured.");
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await callTavily({ endpoint, apiKey, query, fetchImpl, timeoutMs });
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === 1) throw error;
      }
    }
    throw lastError;
  };
}

async function callTavily(options: {
  endpoint: string;
  apiKey: string;
  query: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
}): Promise<HostedSearchResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.fetchImpl(options.endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${options.apiKey}`,
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        query: options.query,
        search_depth: "basic",
        max_results: 5,
        include_answer: false,
        include_raw_content: false,
        include_images: false
      })
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      throw new SearchProviderError(
        response.status === 429 ? 429 : response.status >= 500 ? 503 : 502,
        response.status === 429 ? "search_quota_exceeded" : "search_provider_failed",
        `Tavily search failed with status ${response.status}.`
      );
    }
    return normalizeTavilyResponse(options.query, body);
  } catch (error) {
    if (isAbortError(error)) {
      throw new SearchProviderError(504, "search_timeout", "Tavily search timed out.");
    }
    if (error instanceof SearchProviderError) throw error;
    throw new SearchProviderError(503, "search_unavailable", "Tavily search is unavailable.");
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeTavilyResponse(query: string, body: Record<string, unknown>): HostedSearchResponse {
  const results = Array.isArray(body.results) ? body.results : [];
  return {
    query: boundedString(body.query, 500) || query,
    results: results
      .map((item) => normalizeTavilyResult(item))
      .filter((item): item is HostedSearchResultItem => Boolean(item))
      .slice(0, 5),
    ...(boundedString(body.request_id, 160) ? { requestId: boundedString(body.request_id, 160) } : {})
  };
}

function normalizeTavilyResult(value: unknown): HostedSearchResultItem | null {
  const record = asRecord(value);
  const title = boundedString(record.title, 240);
  const url = safePublicUrl(record.url);
  const snippet = boundedString(record.content || record.snippet, 1200);
  const publishedAt = boundedString(record.published_date || record.publishedAt, 80);
  if (!title || !url || !snippet) return null;
  return { title, url, snippet, ...(publishedAt ? { publishedAt } : {}) };
}

function safePublicUrl(value: unknown): string {
  const raw = boundedString(value, 1000);
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function isRetryable(error: unknown): boolean {
  return error instanceof SearchProviderError && (error.status === 503 || error.status === 504);
}

function isAbortError(error: unknown): boolean {
  const record = asRecord(error);
  return error instanceof DOMException && error.name === "AbortError" ||
    record.name === "AbortError" || record.code === "ABORT_ERR";
}

function boundedString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.floor(value)))
    : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}
