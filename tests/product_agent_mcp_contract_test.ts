import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createReadOnlyDirexioMcpClient,
  DirexioMcpReadError,
  READ_ONLY_DIREXIO_MCP_TOOLS,
  type McpSession,
  type ReadOnlyDirexioMcpToolName
} from "../product-agent/src/lib/mcp/read-only-direxio-mcp-client.js";
import { InMemoryThreadMemoryStore } from "../product-agent/src/lib/memory/thread-memory.js";
import { FileBackedThreadMemoryStore } from "../product-agent/src/lib/memory/file-thread-memory.js";
import { createMcpReadTools } from "../product-agent/src/lib/tools/mcp-read-tools.js";
import type { AgentToolContext } from "../product-agent/src/lib/tools/types.js";
import { createLangChainAgentRuntime } from "../product-agent/src/lib/runtime/langchain-runtime.js";
import { createAgentServiceApp } from "../product-agent/src/lib/agent-service.js";
import { planTask } from "../product-agent/src/lib/runtime/task-control.js";

await testDisabledClientFailsBeforeStartingSession();
await testIncompleteClientFailsBeforeStartingSession();
await testUnsafeHttpDomainFailsClosed();
await testAllowedToolsReuseOneSession();
await testWriteToolsAreRejectedBeforeTransport();
await testTransportFailureRebuildsOnce();
await testToolErrorsDoNotExposeServerContent();
await testPublishedMcpPackageOverRealStdio();
await testReadToolsExposeOnlyApprovedNames();
await testExplicitContactReadCapsLimitAndFormatsEvidence();
await testUnrelatedTurnCannotReadAppData();
await testMessageResolverIntentAndInvalidArguments();
testPrivateAppDataTaskPlanningBeatsGenericFreshness();
await testLangChainMcpReadReturnsOneReplyAndSkipsAutomaticMemory();
await testLangChainResolvesChannelBeforeReadingPosts();
await testLangChainMcpFailureCannotBecomeFabricatedAnswer();
testPrivateMcpConversationsDoNotCreateCanonicalSummaries();

console.log("product agent mcp contract ok");

async function testDisabledClientFailsBeforeStartingSession(): Promise<void> {
  let starts = 0;
  const client = createReadOnlyDirexioMcpClient({
    env: configuredEnv({ DIREXIO_AGENT_MCP_READ_ONLY: "0" }),
    sessionFactory: async () => {
      starts += 1;
      return fakeSession();
    }
  });
  assert.equal(client.isConfigured(), false);
  await assertReadError(() => client.call("list_contacts", {}), "disabled");
  assert.equal(starts, 0);
}

async function testIncompleteClientFailsBeforeStartingSession(): Promise<void> {
  let starts = 0;
  const client = createReadOnlyDirexioMcpClient({
    env: configuredEnv({ DIREXIO_AGENT_TOKEN: "" }),
    sessionFactory: async () => {
      starts += 1;
      return fakeSession();
    }
  });
  assert.equal(client.isConfigured(), false);
  await assertReadError(() => client.call("list_contacts", {}), "not_configured");
  assert.equal(starts, 0);
}

async function testUnsafeHttpDomainFailsClosed(): Promise<void> {
  let starts = 0;
  const client = createReadOnlyDirexioMcpClient({
    env: configuredEnv({ DIREXIO_AGENT_MCP_DOMAIN: "http://untrusted.example/mcp" }),
    sessionFactory: async () => {
      starts += 1;
      return fakeSession();
    }
  });
  assert.equal(client.isConfigured(), false);
  await assertReadError(() => client.call("list_contacts", {}), "not_configured");
  assert.equal(starts, 0);
}

async function testAllowedToolsReuseOneSession(): Promise<void> {
  let starts = 0;
  let closes = 0;
  const called: string[] = [];
  const client = createReadOnlyDirexioMcpClient({
    env: configuredEnv(),
    sessionFactory: async (config) => {
      starts += 1;
      assert.equal(config.domain, "http://message-server:8008");
      assert.equal(config.agentToken, "agent-secret");
      assert.equal(config.agentRoomId, "!agent:example.test");
      return {
        async callTool(params) {
          called.push(params.name);
          return {
            content: [{ type: "text", text: JSON.stringify({ tool: params.name }) }]
          };
        },
        async close() {
          closes += 1;
        }
      };
    }
  });
  assert.equal(client.isConfigured(), true);
  for (const toolName of READ_ONLY_DIREXIO_MCP_TOOLS) {
    const result = await client.call(toolName, { limit: 1 });
    assert.equal(result.tool, toolName);
  }
  assert.equal(starts, 1);
  assert.deepEqual(called, [...READ_ONLY_DIREXIO_MCP_TOOLS]);
  await client.close();
  assert.equal(closes, 1);
}

async function testWriteToolsAreRejectedBeforeTransport(): Promise<void> {
  let calls = 0;
  const client = createReadOnlyDirexioMcpClient({
    env: configuredEnv(),
    sessionFactory: async () => ({
      async callTool() {
        calls += 1;
        return {};
      },
      async close() {}
    })
  });
  await assertReadError(
    () => client.call("send_message" as ReadOnlyDirexioMcpToolName, { room_id: "room", msg: "no" }),
    "tool_not_allowed"
  );
  await assertReadError(
    () => client.call("comment_channel_post" as ReadOnlyDirexioMcpToolName, { post_id: "post", msg: "no" }),
    "tool_not_allowed"
  );
  assert.equal(calls, 0);
}

async function testTransportFailureRebuildsOnce(): Promise<void> {
  let starts = 0;
  let firstClosed = false;
  const client = createReadOnlyDirexioMcpClient({
    env: configuredEnv(),
    sessionFactory: async () => {
      starts += 1;
      if (starts === 1) {
        return {
          async callTool() {
            throw new Error("transport included agent-secret but it must stay private");
          },
          async close() {
            firstClosed = true;
          }
        };
      }
      return fakeSession({ structuredContent: { contacts: [] } });
    }
  });
  const result = await client.call("list_contacts", {});
  assert.deepEqual(result.contacts, []);
  assert.equal(starts, 2);
  assert.equal(firstClosed, true);
  await client.close();
}

async function testToolErrorsDoNotExposeServerContent(): Promise<void> {
  let starts = 0;
  const client = createReadOnlyDirexioMcpClient({
    env: configuredEnv(),
    sessionFactory: async () => {
      starts += 1;
      return fakeSession({
        isError: true,
        content: [{ type: "text", text: "private room content and agent-secret" }]
      });
    }
  });
  let error: unknown;
  try {
    await client.call("list_messages", { room_id: "!private:example.test" });
  } catch (caught) {
    error = caught;
  }
  assert.equal(error instanceof DirexioMcpReadError, true);
  assert.equal((error as DirexioMcpReadError).code, "tool_error");
  assert.equal(String(error).includes("agent-secret"), false);
  assert.equal(String(error).includes("private room content"), false);
  assert.equal(starts, 1);
  await client.close();
}

async function testPublishedMcpPackageOverRealStdio(): Promise<void> {
  let observedAction = "";
  let observedAuthorization = "";
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    observedAction = String(body.action || "");
    observedAuthorization = String(request.headers.authorization || "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ rooms: [{ name: "Real stdio", room_id: "!stdio:test" }] }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = createReadOnlyDirexioMcpClient({
    env: configuredEnv({
      DIREXIO_AGENT_MCP_DOMAIN: `http://127.0.0.1:${address.port}`,
      DIREXIO_AGENT_ROOM_ID: ""
    })
  });
  try {
    const result = await client.call("list_contacts", { limit: 1 });
    assert.equal(observedAction, "mcp.rooms.search");
    assert.equal(observedAuthorization, "Bearer agent-secret");
    assert.equal(asRecord((result.rooms as unknown[])[0]).name, "Real stdio");
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function testReadToolsExposeOnlyApprovedNames(): Promise<void> {
  const tools = createMcpReadTools(fakeReadOnlyClient());
  assert.deepEqual(tools.map((tool) => tool.name), [...READ_ONLY_DIREXIO_MCP_TOOLS]);
  assert.equal(tools.some((tool) => tool.name === "send_message"), false);
  assert.equal(tools.some((tool) => tool.name === "comment_channel_post"), false);
  assert.equal(tools.every((tool) => tool.manifest.permissions.every((permission) => permission.access === "read")), true);
}

async function testExplicitContactReadCapsLimitAndFormatsEvidence(): Promise<void> {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = fakeReadOnlyClient(async (name, args) => {
    calls.push({ name, args });
    return {
      contacts: [{ display_name: "Alice", room_id: "!alice:example.test", avatar_url: "private-avatar" }]
    };
  });
  const tool = createMcpReadTools(client).find((item) => item.name === "list_contacts");
  assert.ok(tool);
  const result = await tool.run({ query: "Alice", limit: 999 }, toolContext("请列出我的联系人"));
  assert.equal(result.ok, true);
  assert.equal(result.dataSensitivity, "third_party_app_data");
  assert.deepEqual(calls, [{ name: "list_contacts", args: { query: "Alice", limit: 20 } }]);
  assert.match(result.content, /Alice/);
  assert.match(result.content, /room_id=!alice:example\.test/);
  assert.equal(result.content.includes("avatar"), false);
  assert.equal(result.content.trim().startsWith("{"), false);
}

async function testUnrelatedTurnCannotReadAppData(): Promise<void> {
  let calls = 0;
  const tool = createMcpReadTools(fakeReadOnlyClient(async () => {
    calls += 1;
    return { contacts: [] };
  })).find((item) => item.name === "list_contacts");
  assert.ok(tool);
  const result = await tool.run({}, toolContext("今天心情不错", [
    { role: "user", content: "昨天我提到过联系人" },
    { role: "assistant", content: "知道了" }
  ]));
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
  assert.match(result.content, /explicitly ask/i);
}

async function testMessageResolverIntentAndInvalidArguments(): Promise<void> {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = fakeReadOnlyClient(async (name, args) => {
    calls.push({ name, args });
    return name === "search_rooms"
      ? { rooms: [{ name: "Alice", type: "contact", room_id: "!alice:example.test" }] }
      : { messages: [] };
  });
  const tools = createMcpReadTools(client);
  const searchRooms = tools.find((item) => item.name === "search_rooms");
  const listMessages = tools.find((item) => item.name === "list_messages");
  assert.ok(searchRooms);
  assert.ok(listMessages);
  const context = toolContext("总结我和 Alice 最近聊了什么");
  const roomResult = await searchRooms.run({ query: "Alice", type: "contact" }, context);
  assert.equal(roomResult.ok, true);
  const invalid = await listMessages.run({ room_id: "!alice:example.test", unexpected: true }, context);
  assert.equal(invalid.ok, false);
  assert.equal(calls.length, 1);
  assert.match(invalid.content, /invalid arguments/i);
}

function testPrivateAppDataTaskPlanningBeatsGenericFreshness(): void {
  const memory = new InMemoryThreadMemoryStore().snapshot("planner-room");
  assert.equal(planTask("看看产品频道最新帖子", memory).mode, "direct");
  assert.equal(planTask("我的联系人有哪些", memory).mode, "direct");
  assert.equal(planTask("联网搜索最新频道行业新闻", memory).mode, "external_evidence");
}

async function testLangChainMcpReadReturnsOneReplyAndSkipsAutomaticMemory(): Promise<void> {
  let modelCalls = 0;
  let memoryExtractions = 0;
  let mcpCalls = 0;
  const readOnlyMcpClient = fakeReadOnlyClient(async (name) => {
    mcpCalls += 1;
    assert.equal(name, "list_contacts");
    return { contacts: [{ display_name: "Alice", room_id: "!alice:example.test" }] };
  });
  const runtime = createLangChainAgentRuntime({
    env: {} as NodeJS.ProcessEnv,
    readOnlyMcpClient,
    memoryExtractor: {
      async extract() {
        memoryExtractions += 1;
        return [];
      }
    }
  });
  const app = createAgentServiceApp({
    aiToken: "dxai-test",
    gatewayUrl: "http://gateway.test",
    runtime,
    fetchImpl: async (_url, init) => {
      modelCalls += 1;
      const request = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      if (modelCalls === 1) {
        const tools = request.tools as Array<Record<string, unknown>>;
        const names = tools.map((item) => String(asRecord(item.function).name));
        assert.equal(names.includes("list_contacts"), true);
        assert.equal(names.includes("send_message"), false);
        return jsonResponse({
          reply: "",
          tool_calls: [{
            id: "call-contacts",
            name: "list_contacts",
            args: { limit: 5 },
            type: "tool_call"
          }]
        });
      }
      assert.match(JSON.stringify(request.messages), /Contacts: 1/);
      return jsonResponse({ reply: "你有 1 位联系人：Alice。" });
    }
  });
  await app.ready();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/agent/messages",
      payload: {
        conversation_type: "direxio_ai",
        node_id: "node-1",
        conversation_id: "mcp-contact-room",
        messages: [{ sender: "user", content: "请列出我的联系人" }]
      }
    });
    const body = response.json() as Record<string, unknown>;
    assert.equal(response.statusCode, 200);
    assert.equal(body.reply, "你有 1 位联系人：Alice。");
    assert.equal(asRecord(body.outbound_message).content, body.reply);
    assert.equal(String(body.reply).includes("{"), false);
    assert.equal(modelCalls, 2);
    assert.equal(mcpCalls, 1);
    assert.equal(memoryExtractions, 0);
  } finally {
    await app.close();
  }
}

async function testLangChainResolvesChannelBeforeReadingPosts(): Promise<void> {
  let modelCalls = 0;
  const mcpCalls: string[] = [];
  const runtime = createLangChainAgentRuntime({
    autoMemoryEnabled: false,
    env: {} as NodeJS.ProcessEnv,
    readOnlyMcpClient: fakeReadOnlyClient(async (name, args) => {
      mcpCalls.push(name);
      if (name === "search_rooms") {
        return { rooms: [{ name: "产品", type: "channel", room_id: "!product:example.test" }] };
      }
      assert.equal(name, "list_channel_posts");
      assert.equal(args.room_id, "!product:example.test");
      return { posts: [{ post_id: "post-1", sender: "Alice", msg: "Release ready" }] };
    })
  });
  const app = createAgentServiceApp({
    aiToken: "dxai-test",
    gatewayUrl: "http://gateway.test",
    runtime,
    fetchImpl: async () => {
      modelCalls += 1;
      if (modelCalls === 1) {
        return jsonResponse({
          reply: "",
          tool_calls: [{
            id: "call-channel",
            name: "search_rooms",
            args: { query: "产品", type: "channel", limit: 5 },
            type: "tool_call"
          }]
        });
      }
      if (modelCalls === 2) {
        return jsonResponse({
          reply: "",
          tool_calls: [{
            id: "call-posts",
            name: "list_channel_posts",
            args: { room_id: "!product:example.test", limit: 5 },
            type: "tool_call"
          }]
        });
      }
      return jsonResponse({ reply: "产品频道最新帖子：Release ready。" });
    }
  });
  await app.ready();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/agent/messages",
      payload: {
        conversation_type: "direxio_ai",
        node_id: "node-1",
        conversation_id: "mcp-channel-room",
        messages: [{ sender: "user", content: "看看产品频道最新帖子" }]
      }
    });
    const body = response.json() as Record<string, unknown>;
    assert.equal(response.statusCode, 200);
    assert.equal(body.reply, "产品频道最新帖子：Release ready。");
    assert.equal(asRecord(body.outbound_message).content, body.reply);
    assert.deepEqual(mcpCalls, ["search_rooms", "list_channel_posts"]);
    assert.equal(modelCalls, 3);
  } finally {
    await app.close();
  }
}

async function testLangChainMcpFailureCannotBecomeFabricatedAnswer(): Promise<void> {
  let modelCalls = 0;
  const runtime = createLangChainAgentRuntime({
    autoMemoryEnabled: false,
    env: {} as NodeJS.ProcessEnv,
    readOnlyMcpClient: fakeReadOnlyClient(async () => {
      throw new DirexioMcpReadError("unavailable");
    })
  });
  const app = createAgentServiceApp({
    aiToken: "dxai-test",
    gatewayUrl: "http://gateway.test",
    runtime,
    fetchImpl: async () => {
      modelCalls += 1;
      return modelCalls === 1
        ? jsonResponse({
            reply: "",
            tool_calls: [{
              id: "call-contacts-failed",
              name: "list_contacts",
              args: {},
              type: "tool_call"
            }]
          })
        : jsonResponse({ reply: "你有 99 位联系人，这是我猜的。" });
    }
  });
  await app.ready();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/agent/messages",
      payload: {
        conversation_type: "direxio_ai",
        node_id: "node-1",
        conversation_id: "mcp-failure-room",
        messages: [{ sender: "user", content: "我的联系人有哪些" }]
      }
    });
    const body = response.json() as Record<string, unknown>;
    assert.equal(response.statusCode, 200);
    assert.equal(body.reply, "App 数据暂时不可用或未授权，请稍后再试。");
    assert.equal(asRecord(body.outbound_message).content, body.reply);
    assert.equal(JSON.stringify(body).includes("99"), false);
    assert.equal(modelCalls, 2);
  } finally {
    await app.close();
  }
}

function testPrivateMcpConversationsDoNotCreateCanonicalSummaries(): void {
  const messages = [
    { role: "user" as const, content: "first" },
    { role: "assistant" as const, content: "private MCP-derived answer" },
    { role: "user" as const, content: "third" }
  ];
  const inMemory = new InMemoryThreadMemoryStore(2, { compressionChunkMessages: 2 });
  inMemory.rememberMessages("private-room", messages);
  assert.equal(inMemory.listMemories("private-room").some((item) => item.type === "thread_summary"), true);
  inMemory.markConversationPrivateData("private-room");
  assert.equal(inMemory.listMemories("private-room").some((item) => item.type === "thread_summary"), false);
  inMemory.rememberMessages("private-room", messages);
  assert.equal(inMemory.listMemories("private-room").some((item) => item.type === "thread_summary"), false);
  assert.equal(inMemory.snapshot("private-room").recentMessages.length <= 2, true);

  const dataDir = mkdtempSync(join(tmpdir(), "direxio-mcp-memory-"));
  try {
    const first = new FileBackedThreadMemoryStore({
      dataDir,
      maxMessages: 2,
      compressionChunkMessages: 2
    });
    first.rememberMessages("private-room", messages);
    assert.equal(first.listMemories("private-room").some((item) => item.type === "thread_summary"), true);
    first.markConversationPrivateData("private-room");
    assert.equal(first.listMemories("private-room").some((item) => item.type === "thread_summary"), false);

    const restarted = new FileBackedThreadMemoryStore({
      dataDir,
      maxMessages: 2,
      compressionChunkMessages: 2
    });
    restarted.rememberMessages("private-room", messages);
    assert.equal(restarted.listMemories("private-room").some((item) => item.type === "thread_summary"), false);
    assert.equal(restarted.snapshot("private-room").recentMessages.length <= 2, true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function fakeSession(result: unknown = { structuredContent: { ok: true } }): McpSession {
  return {
    async callTool() {
      return result;
    },
    async close() {}
  };
}

function fakeReadOnlyClient(
  caller: (
    name: ReadOnlyDirexioMcpToolName,
    args: Record<string, unknown>
  ) => Promise<Record<string, unknown>> = async () => ({})
) {
  return {
    isConfigured: () => true,
    call: caller,
    async close() {}
  };
}

function toolContext(
  latestUserMessage: string,
  earlierMessages: AgentToolContext["payload"]["messages"] = []
): AgentToolContext {
  const messages = [...earlierMessages, { role: "user" as const, content: latestUserMessage }];
  return {
    event: {},
    payload: {
      node_id: "node-1",
      conversation_id: "room-1",
      task: "chat",
      model: "default",
      messages
    },
    memory: new InMemoryThreadMemoryStore().snapshot("room-1"),
    fetchImpl: globalThis.fetch,
    env: {}
  };
}

function configuredEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DIREXIO_AGENT_MCP_READ_ONLY: "1",
    DIREXIO_AGENT_MCP_DOMAIN: "http://message-server:8008/",
    DIREXIO_AGENT_TOKEN: "agent-secret",
    DIREXIO_AGENT_ROOM_ID: "!agent:example.test",
    DIREXIO_AGENT_MCP_TIMEOUT_MS: "1000",
    ...overrides
  };
}

async function assertReadError(
  operation: () => Promise<unknown>,
  code: DirexioMcpReadError["code"]
): Promise<void> {
  let error: unknown;
  try {
    await operation();
  } catch (caught) {
    error = caught;
  }
  assert.equal(error instanceof DirexioMcpReadError, true);
  assert.equal((error as DirexioMcpReadError).code, code);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
