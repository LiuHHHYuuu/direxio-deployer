#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { createAgentServiceApp } from "../product-agent/src/lib/agent-service.js";
import { createAiGatewayApp, createDefaultModelClient, ModelProviderError } from "../product-agent/src/lib/ai-gateway.js";
import { createDevIntegrationApp } from "../product-agent/src/bin/dev-integration-server.js";
import { toAgentMessageEvent } from "../product-agent/src/lib/message-server-adapter.js";

interface InjectableApp {
  inject(options: {
    method: string;
    url: string;
    headers: Record<string, string>;
    payload: unknown;
  }): Promise<{
    statusCode: number;
    json(): unknown;
  }>;
}

await testGatewayAuthAndSuccess();
await testGatewayExplicitRealModelMode();
await testGatewayHidesProviderDebugByDefault();
await testGatewayShowsProviderDebugWhenEnabled();
await testAgentIgnoresNonAiConversation();
await testAgentRequiresHostedToken();
await testAgentMapsGatewayErrors();
await testAgentForwardsOnlyAllowedContext();
await testAgentServiceMessageServerEndpointIgnoresNonAiConversation();
await testAgentServiceMessageServerEndpointReturnsOutboundMessage();
await testMessageServerAdapterIgnoresNonAiConversations();
await testMessageServerAdapterBuildsAgentEvent();
await testMessageServerAdapterAcceptsNativeAgentConversation();
await testDevIntegrationServerEndToEnd();

console.log("product agent contract ok");

async function testGatewayAuthAndSuccess(): Promise<void> {
  const app = createAiGatewayApp({
    verifyToken: async (token) => token === "dxai_ok",
    modelClient: async (chat) => ({ reply: `ok:${chat.messages.at(-1)?.content}` })
  });
  await app.ready();
  try {
    const noAuth = await injectJson(app, "/v1/chat", {});
    assert.equal(noAuth.status, 401);

    const success = await injectJson(app, "/v1/chat", {
      node_id: "node-1",
      conversation_id: "room-1",
      messages: [{ role: "user", content: "hello" }]
    }, "dxai_ok");
    assert.equal(success.status, 200);
    assert.equal(success.body.reply, "ok:hello");
  } finally {
    await app.close();
  }
}

async function testGatewayExplicitRealModelMode(): Promise<void> {
  const modelClient = createDefaultModelClient({
    env: {
      DIREXIO_AI_GATEWAY_MODEL_MODE: "openai-compatible",
      DIREXIO_MODEL_API_KEY: "provider_test_key",
      DIREXIO_MODEL_BASE_URL: "http://provider.test/v1",
      DIREXIO_MODEL_NAME: "test-model"
    } as NodeJS.ProcessEnv,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      assert.equal(body.model, "test-model");
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer provider_test_key");
      return new Response(JSON.stringify({
        choices: [{ message: { content: "real-model-reply" } }],
        usage: { total_tokens: 12 }
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  const result = await modelClient({
    node_id: "node-1",
    conversation_id: "ai-room",
    task: "chat",
    model: "default",
    messages: [{ role: "user", content: "hello" }]
  });
  assert.equal(result.reply, "real-model-reply");
}

async function testGatewayHidesProviderDebugByDefault(): Promise<void> {
  const app = createAiGatewayApp({
    verifyToken: async (token) => token === "dxai_ok",
    modelClient: async () => {
      throw new ModelProviderError("provider failed", 502, "provider_error", {
        status: 400,
        body: "{\"error\":\"bad model\"}"
      });
    }
  });
  await app.ready();
  try {
    const response = await injectJson(app, "/v1/chat", {
      node_id: "node-1",
      conversation_id: "room-1",
      messages: [{ role: "user", content: "hello" }]
    }, "dxai_ok");
    assert.equal(response.status, 502);
    const error = asRecord(response.body.error);
    assert.equal(error.code, "provider_error");
    assert.equal(Object.hasOwn(error, "provider_body"), false);
  } finally {
    await app.close();
  }
}

async function testGatewayShowsProviderDebugWhenEnabled(): Promise<void> {
  const app = createAiGatewayApp({
    env: { DIREXIO_AI_GATEWAY_DEBUG_PROVIDER: "1" } as NodeJS.ProcessEnv,
    verifyToken: async (token) => token === "dxai_ok",
    modelClient: async () => {
      throw new ModelProviderError("provider failed", 502, "provider_error", {
        status: 400,
        body: "{\"error\":\"bad model\"}"
      });
    }
  });
  await app.ready();
  try {
    const response = await injectJson(app, "/v1/chat", {
      node_id: "node-1",
      conversation_id: "room-1",
      messages: [{ role: "user", content: "hello" }]
    }, "dxai_ok");
    assert.equal(response.status, 502);
    const error = asRecord(response.body.error);
    assert.equal(error.provider_status, 400);
    assert.equal(error.provider_body, "{\"error\":\"bad model\"}");
  } finally {
    await app.close();
  }
}

async function testAgentIgnoresNonAiConversation(): Promise<void> {
  let called = false;
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://unused.invalid",
    fetchImpl: async () => {
      called = true;
      throw new Error("gateway should not be called");
    }
  });
  await app.ready();
  try {
    const response = await injectJson(app, "/v1/agent/messages", {
      conversation_type: "human_dm",
      conversation_id: "human-room",
      messages: [{ sender: "user", content: "hello" }]
    });
    assert.equal(response.status, 202);
    assert.equal(response.body.ignored, true);
    assert.equal(called, false);
  } finally {
    await app.close();
  }
}

async function testAgentRequiresHostedToken(): Promise<void> {
  const app = createAgentServiceApp({
    aiToken: "",
    fetchImpl: async () => {
      throw new Error("gateway should not be called");
    }
  });
  await app.ready();
  try {
    const response = await injectJson(app, "/v1/agent/messages", aiEvent());
    assert.equal(response.status, 503);
    assert.equal(errorCode(response.body), "setup_needed");
  } finally {
    await app.close();
  }
}

async function testAgentMapsGatewayErrors(): Promise<void> {
  const cases: Array<[number, number, string]> = [
    [401, 503, "hosted_ai_auth_failed"],
    [429, 429, "quota_exceeded"],
    [500, 503, "temporary_unavailable"]
  ];

  for (const [gatewayStatus, expectedStatus, expectedCode] of cases) {
    const app = createAgentServiceApp({
      aiToken: "dxai_ok",
      gatewayUrl: "http://gateway.test",
      fetchImpl: async () => new Response(JSON.stringify({ error: { code: "upstream" } }), {
        status: gatewayStatus,
        headers: { "Content-Type": "application/json" }
      })
    });
    await app.ready();
    try {
      const response = await injectJson(app, "/v1/agent/messages", aiEvent());
      assert.equal(response.status, expectedStatus);
      assert.equal(errorCode(response.body), expectedCode);
    } finally {
      await app.close();
    }
  }
}

async function testAgentForwardsOnlyAllowedContext(): Promise<void> {
  const captured: unknown[] = [];
  const fetchImpl = async (_url: string | URL, init?: RequestInit): Promise<Response> => {
    captured.push(JSON.parse(String(init?.body || "{}")));
    return new Response(JSON.stringify({ reply: "draft" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    fetchImpl
  });
  await app.ready();
  try {
    const unauthorized = await injectJson(app, "/v1/agent/messages", {
      ...aiEvent(),
      selected_context: "private human chat",
      context_authorized: false,
      secret_note: "must not forward"
    });
    assert.equal(unauthorized.status, 200);
    assert.equal(asRecord(captured[0]).messages instanceof Array, true);
    const unauthorizedMessages = asRecord(captured[0]).messages as Array<Record<string, unknown>>;
    assert.equal(unauthorizedMessages.length, 1);
    assert.equal(unauthorizedMessages[0]?.content, "hello ai");
    assert.equal(Object.hasOwn(asRecord(captured[0]), "secret_note"), false);

    const authorized = await injectJson(app, "/v1/agent/messages", {
      ...aiEvent(),
      selected_context: "selected text",
      context_authorized: true
    });
    assert.equal(authorized.status, 200);
    const authorizedMessages = asRecord(captured[1]).messages as Array<Record<string, unknown>>;
    assert.equal(authorizedMessages.length, 2);
    assert.match(String(authorizedMessages[0]?.content), /Selected context:\nselected text/);
  } finally {
    await app.close();
  }
}

async function testAgentServiceMessageServerEndpointIgnoresNonAiConversation(): Promise<void> {
  let called = false;
  const app = createAgentServiceApp({
    aiToken: "",
    fetchImpl: async () => {
      called = true;
      throw new Error("gateway should not be called");
    }
  });
  await app.ready();
  try {
    const response = await injectJson(app, "/v1/message-server/new-message", {
      node_id: "node-1",
      conversation_id: "human-room",
      conversation_type: "human_dm",
      content: "hello human"
    });
    assert.equal(response.status, 202);
    assert.equal(response.body.ignored, true);
    assert.equal(called, false);
  } finally {
    await app.close();
  }
}

async function testAgentServiceMessageServerEndpointReturnsOutboundMessage(): Promise<void> {
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      const messages = payload.messages as Array<Record<string, unknown>>;
      return new Response(JSON.stringify({ reply: `agent:${messages.at(-1)?.content}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await app.ready();
  try {
    const response = await injectJson(app, "/v1/message-server/new-message", {
      node_id: "node-1",
      conversation_id: "ai-room",
      conversation_type: "direxio_ai",
      sender_kind: "user",
      content: "hello ai"
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.reply, "agent:hello ai");
    const outbound = asRecord(response.body.outbound_message);
    assert.equal(outbound.conversation_id, "ai-room");
    assert.equal(outbound.content, "agent:hello ai");
  } finally {
    await app.close();
  }
}

function testMessageServerAdapterIgnoresNonAiConversations(): void {
  const adapted = toAgentMessageEvent({
    node_id: "node-1",
    conversation_id: "human-room",
    conversation_type: "human_dm",
    content: "do not forward"
  });
  assert.deepEqual(adapted, { ignored: true, reason: "not_ai_conversation" });
}

function testMessageServerAdapterBuildsAgentEvent(): void {
  const adapted = toAgentMessageEvent({
    node_id: "node-1",
    conversation_id: "ai-room",
    conversation_type: "direxio_ai",
    sender_kind: "user",
    content: "hello ai",
    recent_messages: [{ sender: "assistant", content: "previous reply" }],
    selected_context: "selected text",
    context_authorized: true
  });
  assert.equal("ignored" in adapted, false);
  if ("ignored" in adapted) return;
  assert.equal(adapted.conversation_type, "direxio_ai");
  assert.equal(adapted.messages.length, 2);
  assert.equal(adapted.messages[0]?.content, "previous reply");
  assert.equal(adapted.messages[1]?.content, "hello ai");
  assert.equal(adapted.selected_context, "selected text");
  assert.equal(adapted.context_authorized, true);
}

function testMessageServerAdapterAcceptsNativeAgentConversation(): void {
  const adapted = toAgentMessageEvent({
    node_id: "node-1",
    room_id: "!agents:example.com",
    conversation_type: "agent",
    sender_kind: "user",
    content: "hello from native app"
  });
  assert.equal("ignored" in adapted, false);
  if ("ignored" in adapted) return;
  assert.equal(adapted.conversation_type, "direxio_ai");
  assert.equal(adapted.conversation_id, "!agents:example.com");
  assert.equal(adapted.messages.at(-1)?.content, "hello from native app");
}

async function testDevIntegrationServerEndToEnd(): Promise<void> {
  const app = await createDevIntegrationApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      const messages = payload.messages as Array<Record<string, unknown>>;
      return new Response(JSON.stringify({ reply: `agent:${messages.at(-1)?.content}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await app.ready();
  try {
    const response = await injectJson(app, "/dev/message-server/new-message", {
      node_id: "node-1",
      conversation_id: "ai-room",
      conversation_type: "direxio_ai",
      sender_kind: "user",
      content: "hello from app"
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.reply, "agent:hello from app");
    const outbound = asRecord(response.body.outbound_message);
    assert.equal(outbound.conversation_id, "ai-room");
    assert.equal(outbound.content, "agent:hello from app");
  } finally {
    await app.close();
  }
}

function aiEvent(): Record<string, unknown> {
  return {
    conversation_type: "direxio_ai",
    node_id: "node-1",
    conversation_id: "ai-room",
    messages: [{ sender: "user", content: "hello ai" }]
  };
}

async function injectJson(app: InjectableApp, url: string, body: unknown, token?: string): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await app.inject({
    method: "POST",
    url,
    headers,
    payload: body
  });
  return {
    status: response.statusCode,
    body: response.json() as Record<string, unknown>
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function errorCode(body: Record<string, unknown>): string {
  const error = asRecord(body.error);
  return typeof error.code === "string" ? error.code : "";
}
