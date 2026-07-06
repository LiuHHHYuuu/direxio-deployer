import type { CurrentThreadMcpClient } from "../mcp/current-thread-mcp-client.js";
import type { GatewayMessage } from "../types.js";
import type { AgentTool, AgentToolContext, AgentToolResult } from "./types.js";

export interface McpCurrentThreadToolOptions {
  client?: CurrentThreadMcpClient;
}

export function createMcpCurrentThreadTool(options: McpCurrentThreadToolOptions = {}): AgentTool {
  return {
    name: "mcp_current_thread_search",
    description: [
      "Search the current Direxio AI thread through MCP only when MCP is configured.",
      "Do not search other conversations or private human chats."
    ].join(" "),
    run: async (input, context) => runMcpCurrentThreadSearch(input, context, options.client)
  };
}

async function runMcpCurrentThreadSearch(
  input: Record<string, unknown>,
  context: AgentToolContext,
  client?: CurrentThreadMcpClient
): Promise<AgentToolResult> {
  const query = stringInput(input.query);
  if (!query) return ok("No MCP search query was provided.");
  if (context.env.DIREXIO_AGENT_MCP_CURRENT_THREAD !== "1" || !client) {
    return ok(
      "MCP current-thread search is disabled for this node. Set DIREXIO_AGENT_MCP_CURRENT_THREAD=1 and provide a CurrentThreadMcpClient to enable it."
    );
  }

  try {
    const result = await client.searchCurrentThread({
      nodeId: context.payload.node_id,
      conversationId: context.payload.conversation_id,
      query,
      limit: numberInput(input.limit, 5)
    });
    const header = result.source ? `source: ${result.source}` : "";
    const body = result.messages.length
      ? formatMessages(result.messages)
      : "No matching messages in the current MCP thread.";
    return ok([header, body].filter(Boolean).join("\n"));
  } catch {
    return {
      name: "mcp_current_thread_search",
      ok: false,
      content: "MCP current-thread search failed."
    };
  }
}

function formatMessages(messages: GatewayMessage[]): string {
  return messages.map((message) => `${message.role}: ${message.content}`).join("\n");
}

function numberInput(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(20, Math.floor(value))) : fallback;
}

function stringInput(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function ok(content: string): AgentToolResult {
  return { name: "mcp_current_thread_search", ok: true, content };
}
