import {
  DirexioMcpReadError,
  type ReadOnlyDirexioMcpClient,
  type ReadOnlyDirexioMcpToolName
} from "../mcp/read-only-direxio-mcp-client.js";
import { latestUserExplicitlyAuthorizesMcpRead } from "./mcp-read-policy.js";
import type {
  AgentTool,
  AgentToolContext,
  AgentToolManifest,
  AgentToolResult
} from "./types.js";

export function createMcpReadTools(client: ReadOnlyDirexioMcpClient): AgentTool[] {
  if (!client.isConfigured()) return [];
  return [
    mcpTool({
      name: "list_contacts",
      description: "List or search the user's accepted Direxio contacts only when the latest user turn explicitly asks for contacts or friends.",
      title: "联系人",
      category: "contacts",
      scope: "contacts",
      inputSchema: propertiesSchema({
        query: { type: "string", maxLength: 200 },
        limit: { type: "number", minimum: 1, maximum: 20 }
      }),
      client
    }),
    mcpTool({
      name: "search_rooms",
      description: "Find the user's Direxio direct chats, groups, or channels when the latest user turn explicitly asks for App conversations.",
      title: "查找会话",
      category: "rooms",
      scope: "rooms",
      inputSchema: propertiesSchema({
        query: { type: "string", maxLength: 200 },
        type: { type: "string", enum: ["contact", "group", "channel", "all"] },
        limit: { type: "number", minimum: 1, maximum: 20 }
      }),
      client
    }),
    mcpTool({
      name: "list_messages",
      description: "Read recent ordinary messages from one authorized Direxio room when the latest user turn explicitly asks for message history.",
      title: "读取消息",
      category: "rooms",
      scope: "messages",
      inputSchema: pagedRoomSchema(),
      client
    }),
    mcpTool({
      name: "list_room_members",
      description: "List members of one authorized Direxio group or channel when the latest user turn explicitly asks who is in it.",
      title: "会话成员",
      category: "rooms",
      scope: "rooms",
      inputSchema: propertiesSchema({
        room_id: { type: "string", minLength: 1, maxLength: 512 },
        limit: { type: "number", minimum: 1, maximum: 20 }
      }, ["room_id"]),
      client
    }),
    mcpTool({
      name: "list_channel_posts",
      description: "Read recent posts from one authorized Direxio channel when the latest user turn explicitly asks for channel posts or content.",
      title: "频道帖子",
      category: "channels",
      scope: "channel_content",
      inputSchema: pagedRoomSchema(),
      client
    }),
    mcpTool({
      name: "list_post_comments",
      description: "Read comments on one authorized Direxio channel post when the latest user turn explicitly asks for its comments.",
      title: "帖子评论",
      category: "channels",
      scope: "channel_content",
      inputSchema: propertiesSchema({
        post_id: { type: "string", minLength: 1, maxLength: 512 },
        from_time: { type: "string" },
        to_time: { type: "string" },
        cursor: { type: "string", maxLength: 2048 },
        limit: { type: "number", minimum: 1, maximum: 20 }
      }, ["post_id"]),
      client
    })
  ];
}

interface McpToolOptions {
  name: ReadOnlyDirexioMcpToolName;
  description: string;
  title: string;
  category: AgentToolManifest["category"];
  scope: AgentToolManifest["permissions"][number]["scope"];
  inputSchema: Record<string, unknown>;
  client: ReadOnlyDirexioMcpClient;
}

function mcpTool(options: McpToolOptions): AgentTool {
  return {
    name: options.name,
    description: options.description,
    manifest: {
      schema: "direxio.agent_tool.v1",
      name: options.name,
      title: options.title,
      description: options.description,
      category: options.category,
      source: "mcp",
      skillKind: "mcp",
      defaultEnabled: true,
      permissions: [{ scope: options.scope, access: "read", required: true }],
      inputSchema: options.inputSchema,
      outputKind: "text",
      triggerExamples: [],
      shareable: false,
      capabilities: ["private_app_data"],
      produces: [options.name]
    },
    run: (input, context) => runMcpRead(options.name, input, context, options.client)
  };
}

async function runMcpRead(
  toolName: ReadOnlyDirexioMcpToolName,
  input: Record<string, unknown>,
  context: AgentToolContext,
  client: ReadOnlyDirexioMcpClient
): Promise<AgentToolResult> {
  if (!latestUserExplicitlyAuthorizesMcpRead(toolName, context.payload)) {
    return mcpResult(toolName, false, "Please explicitly ask what App contacts, rooms, messages, members, posts, or comments you want to read.");
  }
  try {
    const args = normalizeArgs(toolName, input);
    const value = await client.call(toolName, args);
    return mcpResult(toolName, true, formatMcpResult(toolName, value));
  } catch (error) {
    if (error instanceof InvalidMcpArgumentsError) {
      return mcpResult(toolName, false, "The App-data read request had invalid arguments.");
    }
    if (error instanceof DirexioMcpReadError && error.code === "tool_error") {
      return mcpResult(toolName, false, "This App data is unavailable or not authorized for Agent access.");
    }
    return mcpResult(toolName, false, "App data is temporarily unavailable.");
  }
}

function normalizeArgs(
  toolName: ReadOnlyDirexioMcpToolName,
  input: Record<string, unknown>
): Record<string, unknown> {
  switch (toolName) {
    case "list_contacts":
      assertOnlyKeys(input, ["query", "limit"]);
      return compact({ query: optionalText(input.query, 200), limit: limit(input.limit, 20) });
    case "search_rooms":
      assertOnlyKeys(input, ["query", "type", "limit"]);
      return compact({
        query: optionalText(input.query, 200),
        type: enumValue(input.type, ["contact", "group", "channel", "all"]),
        limit: limit(input.limit, 20)
      });
    case "list_messages":
    case "list_channel_posts":
      assertOnlyKeys(input, ["room_id", "from_time", "to_time", "cursor", "limit"]);
      return pageArgs(input, "room_id");
    case "list_room_members":
      assertOnlyKeys(input, ["room_id", "limit"]);
      return { room_id: requiredText(input.room_id, 512), limit: limit(input.limit, 20) };
    case "list_post_comments":
      assertOnlyKeys(input, ["post_id", "from_time", "to_time", "cursor", "limit"]);
      return pageArgs(input, "post_id");
  }
}

function pageArgs(input: Record<string, unknown>, idKey: "room_id" | "post_id"): Record<string, unknown> {
  return compact({
    [idKey]: requiredText(input[idKey], 512),
    from_time: optionalUtcTimestamp(input.from_time),
    to_time: optionalUtcTimestamp(input.to_time),
    cursor: optionalText(input.cursor, 2048),
    limit: limit(input.limit, 20)
  });
}

function formatMcpResult(toolName: ReadOnlyDirexioMcpToolName, value: Record<string, unknown>): string {
  switch (toolName) {
    case "list_contacts":
      return formatCollection("Contacts", value.contacts ?? value.rooms, (item) => line([
        firstText(item, ["display_name", "name", "remark", "peer_mxid"]),
        labeled("room_id", item.room_id)
      ]));
    case "search_rooms":
      return formatCollection("Rooms", value.rooms, (item) => line([
        firstText(item, ["name", "room_id"]),
        labeled("type", item.type),
        labeled("room_id", item.room_id),
        labeled("last_message", item.last_msg)
      ]));
    case "list_messages":
      return formatCollection("Messages", value.messages, (item) => line([
        firstText(item, ["sender_display_name", "sender", "sender_mxid"]),
        labeled("time", firstValue(item, ["created_at", "origin_server_ts"])),
        labeled("message", firstValue(item, ["msg", "body", "content"]))
      ]));
    case "list_room_members":
      return formatCollection("Members", value.members, (item) => line([
        firstText(item, ["display_name", "user_mxid", "user_id"]),
        labeled("role", item.role),
        labeled("membership", item.membership)
      ]));
    case "list_channel_posts":
      return formatCollection("Channel posts", value.posts, (item) => line([
        firstText(item, ["sender_display_name", "sender", "post_id"]),
        labeled("post_id", item.post_id),
        labeled("time", item.created_at),
        labeled("post", firstValue(item, ["msg", "body", "content"])),
        labeled("comments", item.comment_count)
      ]));
    case "list_post_comments":
      return formatCollection("Post comments", value.comments, (item) => line([
        firstText(item, ["sender_display_name", "sender", "comment_id"]),
        labeled("time", item.created_at),
        labeled("comment", firstValue(item, ["msg", "body", "content"]))
      ]));
  }
}

function formatCollection(
  title: string,
  value: unknown,
  formatter: (item: Record<string, unknown>) => string
): string {
  const items = Array.isArray(value) ? value.slice(0, 20).map(asRecord) : [];
  if (items.length === 0) return `${title}: no matching items.`;
  return [`${title}: ${items.length}`, ...items.map((item, index) => `${index + 1}. ${formatter(item)}`)].join("\n");
}

function line(parts: string[]): string {
  return parts.filter(Boolean).join(" | ");
}

function labeled(label: string, value: unknown): string {
  const text = compactText(value, label === "message" || label === "post" || label === "comment" ? 600 : 200);
  return text ? `${label}=${text}` : "";
}

function firstText(item: Record<string, unknown>, keys: string[]): string {
  return compactText(firstValue(item, keys), 200) || "unknown";
}

function firstValue(item: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (item[key] !== undefined && item[key] !== null && item[key] !== "") return item[key];
  }
  return undefined;
}

function compactText(value: unknown, maxLength: number): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function requiredText(value: unknown, maxLength: number): string {
  const text = optionalText(value, maxLength);
  if (!text) throw new InvalidMcpArgumentsError();
  return text;
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new InvalidMcpArgumentsError();
  const text = value.trim();
  if (!text || text.length > maxLength) throw new InvalidMcpArgumentsError();
  return text;
}

function optionalUtcTimestamp(value: unknown): string | undefined {
  const text = optionalText(value, 64);
  if (!text) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]00:00)$/.test(text) || Number.isNaN(Date.parse(text))) {
    throw new InvalidMcpArgumentsError();
  }
  return text;
}

function limit(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new InvalidMcpArgumentsError();
  }
  return Math.min(20, Math.floor(value));
}

function enumValue(value: unknown, allowed: string[]): string | undefined {
  const text = optionalText(value, 32);
  if (!text) return undefined;
  if (!allowed.includes(text)) throw new InvalidMcpArgumentsError();
  return text;
}

function assertOnlyKeys(input: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new InvalidMcpArgumentsError();
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function mcpResult(name: string, ok: boolean, content: string): AgentToolResult {
  return { name, ok, content, dataSensitivity: "third_party_app_data" };
}

function propertiesSchema(
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {})
  };
}

function pagedRoomSchema(): Record<string, unknown> {
  return propertiesSchema({
    room_id: { type: "string", minLength: 1, maxLength: 512 },
    from_time: { type: "string" },
    to_time: { type: "string" },
    cursor: { type: "string", maxLength: 2048 },
    limit: { type: "number", minimum: 1, maximum: 20 }
  }, ["room_id"]);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

class InvalidMcpArgumentsError extends Error {}
