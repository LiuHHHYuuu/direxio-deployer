import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";

export const READ_ONLY_DIREXIO_MCP_TOOLS = [
  "list_contacts",
  "search_rooms",
  "list_messages",
  "list_room_members",
  "list_channel_posts",
  "list_post_comments"
] as const;

export type ReadOnlyDirexioMcpToolName = typeof READ_ONLY_DIREXIO_MCP_TOOLS[number];

export interface ReadOnlyDirexioMcpClient {
  isConfigured(): boolean;
  call(toolName: ReadOnlyDirexioMcpToolName, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface McpSession {
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

export interface McpChildConfig {
  domain: string;
  agentToken: string;
  agentRoomId?: string;
}

export interface ReadOnlyDirexioMcpClientOptions {
  env?: NodeJS.ProcessEnv;
  sessionFactory?: (config: McpChildConfig) => Promise<McpSession>;
}

export type DirexioMcpReadErrorCode =
  | "disabled"
  | "not_configured"
  | "tool_not_allowed"
  | "tool_error"
  | "unavailable";

export class DirexioMcpReadError extends Error {
  constructor(readonly code: DirexioMcpReadErrorCode) {
    super(safeErrorMessage(code));
    this.name = "DirexioMcpReadError";
  }
}

export function createReadOnlyDirexioMcpClient(
  options: ReadOnlyDirexioMcpClientOptions = {}
): ReadOnlyDirexioMcpClient {
  return new StdioReadOnlyDirexioMcpClient(options);
}

class StdioReadOnlyDirexioMcpClient implements ReadOnlyDirexioMcpClient {
  private readonly config: McpChildConfig | null;
  private readonly enabled: boolean;
  private readonly timeoutMs: number;
  private readonly sessionFactory: (config: McpChildConfig) => Promise<McpSession>;
  private sessionPromise?: Promise<McpSession>;

  constructor(options: ReadOnlyDirexioMcpClientOptions) {
    const env = options.env || process.env;
    this.enabled = env.DIREXIO_AGENT_MCP_READ_ONLY?.trim() === "1";
    this.config = childConfigFromEnv(env);
    this.timeoutMs = integerFromEnv(env.DIREXIO_AGENT_MCP_TIMEOUT_MS, 8000, 1000, 30000);
    this.sessionFactory = options.sessionFactory || createProductionMcpSession;
  }

  isConfigured(): boolean {
    return this.enabled && this.config !== null;
  }

  async call(
    toolName: ReadOnlyDirexioMcpToolName,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (!isReadOnlyDirexioMcpToolName(toolName)) {
      throw new DirexioMcpReadError("tool_not_allowed");
    }
    if (!this.enabled) {
      throw new DirexioMcpReadError("disabled");
    }
    if (!this.config) {
      throw new DirexioMcpReadError("not_configured");
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const session = await this.getSession();
        const result = await withTimeout(
          session.callTool({ name: toolName, arguments: args }),
          this.timeoutMs
        );
        return parseToolResult(result);
      } catch (error) {
        if (error instanceof DirexioMcpReadError && error.code === "tool_error") {
          throw error;
        }
        await this.resetSession();
        if (attempt === 1) {
          throw new DirexioMcpReadError("unavailable");
        }
      }
    }
    throw new DirexioMcpReadError("unavailable");
  }

  async close(): Promise<void> {
    await this.resetSession();
  }

  private getSession(): Promise<McpSession> {
    if (!this.sessionPromise) {
      this.sessionPromise = this.sessionFactory(this.config as McpChildConfig).catch((error) => {
        this.sessionPromise = undefined;
        throw error;
      });
    }
    return this.sessionPromise;
  }

  private async resetSession(): Promise<void> {
    const sessionPromise = this.sessionPromise;
    this.sessionPromise = undefined;
    if (!sessionPromise) return;
    try {
      const session = await sessionPromise;
      await session.close();
    } catch {
      // Closing is best effort; callers receive the safe operation error.
    }
  }
}

async function createProductionMcpSession(config: McpChildConfig): Promise<McpSession> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [dirextalkMcpEntrypoint(), "stdio"],
    env: {
      ...getDefaultEnvironment(),
      DIREXTALK_DOMAIN: config.domain,
      DIREXTALK_AGENT_TOKEN: config.agentToken,
      ...(config.agentRoomId ? { DIREXTALK_AGENT_ROOM_ID: config.agentRoomId } : {})
    },
    stderr: "pipe"
  });
  (transport.stderr as Readable | null)?.resume();
  const client = new Client({ name: "direxio-product-agent", version: "0.1.0" });
  await client.connect(transport);
  return {
    callTool: (params) => client.callTool(params),
    close: () => client.close()
  };
}

function dirextalkMcpEntrypoint(): string {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("dirextalk-mcp/package.json");
  return join(dirname(packageJsonPath), "dist", "index.js");
}

function childConfigFromEnv(env: NodeJS.ProcessEnv): McpChildConfig | null {
  const domain = normalizeMcpDomain(env.DIREXIO_AGENT_MCP_DOMAIN);
  const agentToken = env.DIREXIO_AGENT_TOKEN?.trim() || "";
  if (!domain || !agentToken) return null;
  const agentRoomId = env.DIREXIO_AGENT_ROOM_ID?.trim() || undefined;
  return {
    domain,
    agentToken,
    ...(agentRoomId ? { agentRoomId } : {})
  };
}

function normalizeMcpDomain(value: string | undefined): string | null {
  const raw = value?.trim() || "";
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const safeHttpHosts = new Set(["message-server", "localhost", "127.0.0.1", "[::1]"]);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && safeHttpHosts.has(parsed.hostname))) {
      return null;
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    if (parsed.pathname !== "/" && parsed.pathname !== "") return null;
    return stripTrailingSlash(parsed.origin);
  } catch {
    return null;
  }
}

function parseToolResult(value: unknown): Record<string, unknown> {
  const result = asRecord(value);
  if (result.isError === true) {
    throw new DirexioMcpReadError("tool_error");
  }
  const structured = asRecord(result.structuredContent);
  if (Object.keys(structured).length > 0) return structured;
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map(asRecord)
    .find((item) => item.type === "text" && typeof item.text === "string")?.text;
  if (typeof text !== "string" || !text.trim()) return {};
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return { text: text.trim() };
  }
}

function isReadOnlyDirexioMcpToolName(value: string): value is ReadOnlyDirexioMcpToolName {
  return (READ_ONLY_DIREXIO_MCP_TOOLS as readonly string[]).includes(value);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DirexioMcpReadError("unavailable")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function integerFromEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function safeErrorMessage(code: DirexioMcpReadErrorCode): string {
  switch (code) {
    case "disabled":
      return "Direxio MCP read access is disabled.";
    case "not_configured":
      return "Direxio MCP read access is not configured.";
    case "tool_not_allowed":
      return "This MCP tool is not allowed by the read-only policy.";
    case "tool_error":
      return "Direxio MCP could not complete the requested read.";
    default:
      return "Direxio MCP is temporarily unavailable.";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
