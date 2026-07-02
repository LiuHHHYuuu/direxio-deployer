#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createAgentServiceHandler } from "../product-agent/lib/agent-service.mjs";
import { createAiGatewayHandler } from "../product-agent/lib/ai-gateway.mjs";

await testGatewayAuthAndSuccess();
await testAgentIgnoresNonAiConversation();
await testAgentRequiresHostedToken();
await testAgentMapsGatewayErrors();
await testAgentForwardsOnlyAllowedContext();

console.log("product agent contract ok");

/**
 * Function: Verifies ai-gateway bearer auth and success response behavior.
 * Inputs:
 * - None.
 * Output:
 * - None.
 * Side effects:
 * - Starts and stops an in-process HTTP server.
 * Errors:
 * - Assertion failures indicate contract regressions.
 */
async function testGatewayAuthAndSuccess() {
  const server = await listen(createServer(createAiGatewayHandler({
    verifyToken: async (token) => token === "dxai_ok",
    modelClient: async (chat) => ({ reply: `ok:${chat.messages.at(-1).content}` })
  })));
  try {
    const noAuth = await postJson(server.url("/v1/chat"), {}, null);
    assert.equal(noAuth.status, 401);

    const success = await postJson(server.url("/v1/chat"), {
      node_id: "node-1",
      conversation_id: "room-1",
      messages: [{ role: "user", content: "hello" }]
    }, "dxai_ok");
    assert.equal(success.status, 200);
    assert.equal(success.body.reply, "ok:hello");
  } finally {
    await server.close();
  }
}

/**
 * Function: Verifies agent-service does not call the gateway for unrelated conversations.
 * Inputs:
 * - None.
 * Output:
 * - None.
 * Side effects:
 * - Starts and stops an in-process HTTP server.
 * Errors:
 * - Assertion failures indicate contract regressions.
 */
async function testAgentIgnoresNonAiConversation() {
  let called = false;
  const server = await listen(createServer(createAgentServiceHandler({
    aiToken: "dxai_ok",
    gatewayUrl: "http://unused.invalid",
    fetchImpl: async () => {
      called = true;
      throw new Error("gateway should not be called");
    }
  })));
  try {
    const response = await postJson(server.url("/v1/agent/messages"), {
      conversation_type: "human_dm",
      conversation_id: "human-room",
      messages: [{ sender: "user", content: "hello" }]
    });
    assert.equal(response.status, 202);
    assert.equal(response.body.ignored, true);
    assert.equal(called, false);
  } finally {
    await server.close();
  }
}

/**
 * Function: Verifies agent-service reports setup-needed when the hosted token is missing.
 * Inputs:
 * - None.
 * Output:
 * - None.
 * Side effects:
 * - Starts and stops an in-process HTTP server.
 * Errors:
 * - Assertion failures indicate contract regressions.
 */
async function testAgentRequiresHostedToken() {
  const server = await listen(createServer(createAgentServiceHandler({
    aiToken: "",
    fetchImpl: async () => {
      throw new Error("gateway should not be called");
    }
  })));
  try {
    const response = await postJson(server.url("/v1/agent/messages"), aiEvent());
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, "setup_needed");
  } finally {
    await server.close();
  }
}

/**
 * Function: Verifies agent-service maps hosted gateway errors to product-safe responses.
 * Inputs:
 * - None.
 * Output:
 * - None.
 * Side effects:
 * - Creates Response objects through the Fetch API.
 * Errors:
 * - Assertion failures indicate contract regressions.
 */
async function testAgentMapsGatewayErrors() {
  const cases = [
    [401, 503, "hosted_ai_auth_failed"],
    [429, 429, "quota_exceeded"],
    [500, 503, "temporary_unavailable"]
  ];

  for (const [gatewayStatus, expectedStatus, expectedCode] of cases) {
    const server = await listen(createServer(createAgentServiceHandler({
      aiToken: "dxai_ok",
      gatewayUrl: "http://gateway.test",
      fetchImpl: async () => new Response(JSON.stringify({ error: { code: "upstream" } }), {
        status: gatewayStatus,
        headers: { "Content-Type": "application/json" }
      })
    })));
    try {
      const response = await postJson(server.url("/v1/agent/messages"), aiEvent());
      assert.equal(response.status, expectedStatus);
      assert.equal(response.body.error.code, expectedCode);
    } finally {
      await server.close();
    }
  }
}

/**
 * Function: Verifies agent-service sends only AI conversation content plus explicitly authorized selected context.
 * Inputs:
 * - None.
 * Output:
 * - None.
 * Side effects:
 * - Starts and stops an in-process HTTP server.
 * Errors:
 * - Assertion failures indicate contract regressions.
 */
async function testAgentForwardsOnlyAllowedContext() {
  const captured = [];
  const fetchImpl = async (_url, init) => {
    captured.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ reply: "draft" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  const server = await listen(createServer(createAgentServiceHandler({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    fetchImpl
  })));
  try {
    const unauthorized = await postJson(server.url("/v1/agent/messages"), {
      ...aiEvent(),
      selected_context: "private human chat",
      context_authorized: false,
      secret_note: "must not forward"
    });
    assert.equal(unauthorized.status, 200);
    assert.equal(captured[0].messages.length, 1);
    assert.equal(captured[0].messages[0].content, "hello ai");
    assert.equal(Object.hasOwn(captured[0], "secret_note"), false);

    const authorized = await postJson(server.url("/v1/agent/messages"), {
      ...aiEvent(),
      selected_context: "selected text",
      context_authorized: true
    });
    assert.equal(authorized.status, 200);
    assert.equal(captured[1].messages.length, 2);
    assert.match(captured[1].messages[0].content, /Selected context:\nselected text/);
  } finally {
    await server.close();
  }
}

/**
 * Function: Builds a valid product AI event fixture.
 * Inputs:
 * - None.
 * Output:
 * - Product AI event object.
 * Side effects:
 * - None.
 * Errors:
 * - Does not throw.
 */
function aiEvent() {
  return {
    conversation_type: "direxio_ai",
    node_id: "node-1",
    conversation_id: "ai-room",
    messages: [{ sender: "user", content: "hello ai" }]
  };
}

/**
 * Function: Starts an HTTP server on an ephemeral localhost port.
 * Inputs:
 * - server: Node HTTP server.
 * Output:
 * - Object with url(path) and close() helpers.
 * Side effects:
 * - Opens a local listening socket.
 * Errors:
 * - Rejects when the server fails to listen or close.
 */
async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: (path) => `http://127.0.0.1:${address.port}${path}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

/**
 * Function: Sends a JSON POST request and parses the JSON response.
 * Inputs:
 * - url: Destination URL.
 * - body: JSON-serializable request payload.
 * - token: Optional bearer token.
 * Output:
 * - Object containing HTTP status and parsed body.
 * Side effects:
 * - Sends one local HTTP request.
 * Errors:
 * - Throws when fetch fails.
 */
async function postJson(url, body, token = undefined) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  return {
    status: response.status,
    body: await response.json()
  };
}
