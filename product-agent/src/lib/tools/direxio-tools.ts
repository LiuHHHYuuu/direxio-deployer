import type { CurrentThreadMcpClient } from "../mcp/current-thread-mcp-client.js";
import { callHostedSearch } from "../hosted-search-client.js";
import type { GatewayMessage } from "../types.js";
import { createAgentExperienceTools } from "./agent-experience-tools.js";
import { createMcpCurrentThreadTool } from "./mcp-current-thread-tool.js";
import type { AgentTool, AgentToolContext, AgentToolManifest, AgentToolResult } from "./types.js";

export interface DirexioReadOnlyToolsOptions {
  currentThreadMcpClient?: CurrentThreadMcpClient;
}

export function createDirexioReadOnlyTools(options: DirexioReadOnlyToolsOptions = {}): AgentTool[] {
  return [
    {
      name: "list_recent_ai_messages",
      description: "Read recent messages from the current Direxio AI thread only.",
      manifest: manifest({
        name: "list_recent_ai_messages",
        title: "最近对话",
        description: "读取当前 AI 对话里的最近消息。",
        category: "thread",
        permissions: [{ scope: "current_ai_thread", access: "read", required: true }]
      }),
      run: async (input, context) => ok("list_recent_ai_messages", formatMessages(recentMessages(context, numberInput(input.limit, 5))))
    },
    {
      name: "search_current_ai_thread",
      description: "Search messages from the current Direxio AI thread only.",
      manifest: manifest({
        name: "search_current_ai_thread",
        title: "搜索当前对话",
        description: "只搜索当前 AI 对话，不读取其他聊天。",
        category: "thread",
        permissions: [{ scope: "current_ai_thread", access: "read", required: true }]
      }),
      run: async (input, context) => {
        const query = stringInput(input.query).toLowerCase();
        if (!query) return ok("search_current_ai_thread", "No query was provided.");
        const matches = uniqueMessages([...context.memory.recentMessages, ...context.payload.messages])
          .filter((message) => message.content.toLowerCase().includes(query));
        return ok("search_current_ai_thread", matches.length ? formatMessages(matches) : "No matching messages in the current AI thread.");
      }
    },
    {
      name: "get_thread_memory",
      description: "Read explicit preferences remembered in the current Direxio AI thread.",
      manifest: manifest({
        name: "get_thread_memory",
        title: "读取记忆",
        description: "读取当前 AI 对话里明确记住的偏好。",
        category: "memory",
        permissions: [{ scope: "thread_memory", access: "read", required: true }]
      }),
      run: async (_input, context) => {
        const entries = Object.entries(context.memory.preferences);
        return ok(
          "get_thread_memory",
          entries.length
            ? entries.map(([key, value]) => `${key}: ${value}`).join("\n")
            : "No explicit thread preferences have been remembered yet."
        );
      }
    },
    {
      name: "list_contacts",
      description: "Read contacts only when message-server includes contact data in the agent event.",
      manifest: manifest({
        name: "list_contacts",
        title: "联系人",
        description: "仅在服务端明确传入联系人数据时读取。",
        category: "contacts",
        permissions: [{ scope: "contacts", access: "read", required: true }]
      }),
      run: async (_input, context) => {
        const contacts = Array.isArray(context.event.contacts) ? context.event.contacts : [];
        return ok(
          "list_contacts",
          contacts.length ? JSON.stringify(contacts) : "No contact data was provided to product-agent."
        );
      }
    },
    {
      name: "web_search",
      description: "Search the public web for current, external information when it helps answer the user.",
      manifest: manifest({
        name: "web_search",
        title: "联网搜索",
        description: "联网搜索公开网页；默认关闭，需要节点开启。",
        category: "web",
        permissions: [{ scope: "public_web", access: "read", required: true }],
        defaultEnabled: true,
        capabilities: ["public_web", "fresh_information"],
        produces: ["search_results", "sources"]
      }),
      run: async (input, context) => runWebSearch(input, context)
    },
    ...createAgentExperienceTools(),
    createMcpCurrentThreadTool({ client: options.currentThreadMcpClient })
  ];
}

function recentMessages(context: AgentToolContext, limit: number): GatewayMessage[] {
  return uniqueMessages([...context.memory.recentMessages, ...context.payload.messages]).slice(-limit);
}

async function runWebSearch(input: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult> {
  const query = stringInput(input.query);
  if (!query) return { name: "web_search", ok: false, content: "No web search query was provided." };
  if (!webSearchEnabled(context.env)) {
    return { name: "web_search", ok: false, content: "Web search is disabled." };
  }
  if (!context.gatewayUrl || !context.aiToken) {
    return {
      name: "web_search",
      ok: false,
      content: "Hosted web search credentials are unavailable."
    };
  }
  const result = await callHostedSearch({
    gatewayUrl: context.gatewayUrl,
    aiToken: context.aiToken,
    query,
    fetchImpl: context.fetchImpl
  });
  if (!result.ok) {
    return {
      name: "web_search",
      ok: false,
      content: `Hosted web search failed: ${result.code}.`
    };
  }
  if (result.response.results.length === 0) {
    return { name: "web_search", ok: false, content: "No useful web search result was returned." };
  }
  return {
    name: "web_search",
    ok: true,
    content: formatHostedSearchResponse(result.response.query, result.response.results),
    sources: result.response.results.map((item) => item.url)
  };
}

function formatHostedSearchResponse(
  query: string,
  results: Array<{ title: string; url: string; snippet: string; publishedAt?: string }>
): string {
  return [
    `Search results for: ${query}`,
    ...results.map((item, index) => [
      `${index + 1}. ${item.title}`,
      item.snippet,
      ...(item.publishedAt ? [`Published: ${item.publishedAt}`] : []),
      `Source: ${item.url}`
    ].join("\n"))
  ].join("\n\n");
}

function webSearchEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.DIREXIO_AGENT_WEB_SEARCH?.trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
}

function formatMessages(messages: GatewayMessage[]): string {
  if (messages.length === 0) return "No messages available.";
  return messages.map((message) => `${message.role}: ${message.content}`).join("\n");
}

function uniqueMessages(messages: GatewayMessage[]): GatewayMessage[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    const key = `${message.role}\u0000${message.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function numberInput(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(20, Math.floor(value))) : fallback;
}

function stringInput(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function ok(name: string, content: string): AgentToolResult {
  return { name, ok: true, content };
}

function manifest(input: Omit<AgentToolManifest, "schema" | "outputKind" | "defaultEnabled"> & {
  defaultEnabled?: boolean;
  outputKind?: AgentToolManifest["outputKind"];
}): AgentToolManifest {
  return {
    schema: "direxio.agent_tool.v1",
    ...input,
    source: input.source || "official",
    skillKind: input.skillKind || "built_in",
    inputSchema: input.inputSchema || { type: "object", additionalProperties: true },
    outputKind: input.outputKind || "text",
    defaultEnabled: input.defaultEnabled ?? true,
    triggerExamples: input.triggerExamples || [],
    shareable: input.shareable ?? false
  };
}
