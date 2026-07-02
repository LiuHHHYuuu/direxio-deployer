#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { createAgentServiceApp } from "../product-agent/src/lib/agent-service.js";
import { createAiGatewayApp } from "../product-agent/src/lib/ai-gateway.js";

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
await testAgentIgnoresNonAiConversation();
await testAgentRequiresHostedToken();
await testAgentMapsGatewayErrors();
await testAgentForwardsOnlyAllowedContext();

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
