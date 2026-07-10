#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentServiceApp as createProductAgentServiceApp,
  type AgentServiceOptions
} from "../product-agent/src/lib/agent-service.js";
import { createAiGatewayApp, createDefaultModelClient, ModelProviderError } from "../product-agent/src/lib/ai-gateway.js";
import { createDevIntegrationApp } from "../product-agent/src/bin/dev-integration-server.js";
import { officialExperienceAbilityManifests } from "../product-agent/src/lib/abilities/official-experience-abilities.js";
import { toAgentMessageEvent } from "../product-agent/src/lib/message-server-adapter.js";
import { callHostedGateway } from "../product-agent/src/lib/hosted-gateway-client.js";
import type { CurrentThreadMcpClient, CurrentThreadSearchInput } from "../product-agent/src/lib/mcp/current-thread-mcp-client.js";
import { parseMemoryCandidates, type MemoryCandidate } from "../product-agent/src/lib/memory/memory-candidate.js";
import type { MemoryCandidateExtractor } from "../product-agent/src/lib/memory/memory-extractor.js";
import { evaluateMemoryCandidate } from "../product-agent/src/lib/memory/memory-policy.js";
import { FileBackedThreadMemoryStore } from "../product-agent/src/lib/memory/file-thread-memory.js";
import { InMemoryThreadMemoryStore } from "../product-agent/src/lib/memory/thread-memory.js";
import { createLangChainAgentRuntime } from "../product-agent/src/lib/runtime/langchain-runtime.js";

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

function createAgentServiceApp(options: AgentServiceOptions = {}) {
  return createProductAgentServiceApp({
    ...options,
    env: {
      DIREXIO_AGENT_RUNTIME: "local",
      ...(options.env || {})
    } as NodeJS.ProcessEnv
  });
}

await testGatewayAuthAndSuccess();
await testGatewayExplicitRealModelMode();
await testGatewayForwardsOpenAIToolDefinitionsAndCalls();
await testHostedGatewayTimeout();
await testGatewayHidesProviderDebugByDefault();
await testGatewayShowsProviderDebugWhenEnabled();
await testDirexioAiTokenGenerator();
await testAgentIgnoresNonAiConversation();
await testAgentRequiresHostedToken();
await testAgentDefaultsToLangChainRuntime();
await testAgentMapsGatewayErrors();
await testAgentForwardsOnlyAllowedContext();
await testAgentAddsCurrentThreadToolContext();
testOfficialExperienceAbilitiesArePrivateByDefault();
await testAgentActionMenuEndpoint();
await testAgentToolsEndpoint();
await testAgentMemoryEndpointSaveListDelete();
await testAgentPromptSkillEndpointValidateSaveListDeleteAndRestart();
await testAgentPromptSkillSyncEndpointAcceptsPluginConfigShape();
await testAgentPromptSkillUploadAppearsInToolsAndTriggers();
await testAgentPromptSkillConfigFromMessageServerEventTriggersWithoutPreupload();
await testAgentActionMessageReturnsStructuredCard();
await testAgentNaturalLanguageCardRequestReturnsStructuredOutbound();
await testAgentAddsPersonaCardToolContext();
await testLangChainRuntimeUsesGatewayToolCalls();
await testLangChainRuntimeUsesExperienceCardToolCall();
await testLangChainRuntimeForcesStructuredCardForExplicitCardRequest();
await testLangChainRuntimePromotesStructuredFinalReply();
await testLangChainRuntimeUsesMemorySaveToolCall();
await testLangChainRuntimeExposesDisabledMcpCurrentThreadTool();
await testLangChainRuntimeUsesFakeMcpCurrentThreadTool();
await testLangChainRuntimeStopsAtModelCallLimit();
testAutomaticMemoryCandidateParserAndPolicy();
testOwnerMemoryPersistsAcrossThreadsAndRestart();
await testDefaultAutomaticMemoryExtractorUsesGatewayJson();
await testLangChainRuntimeAutomaticallyCreatesUpdatesAndDeletesOwnerMemory();
await testAutomaticMemoryFailureDoesNotBreakOrDuplicateReply();
await testAgentRemembersThreadPreferences();
await testAgentPersistsExplicitMemoryAcrossRestart();
await testAgentRetrievesVectorMemoryIntoContext();
await testAgentAutoCompactsThreadContextWhenWindowExceeded();
await testAgentWebSearchIsEnabledByDefault();
await testAgentServiceMessageServerEndpointIgnoresNonAiConversation();
await testAgentServiceMessageServerEndpointReturnsOutboundMessage();
await testAgentServiceMessageServerEndpointPromotesStructuredModelReply();
await testMessageServerAdapterIgnoresNonAiConversations();
await testMessageServerAdapterBuildsAgentEvent();
await testMessageServerAdapterBuildsAgentActionEvent();
await testMessageServerAdapterPassesAgentConfig();
await testMessageServerAdapterAcceptsNativeAgentConversation();
await testDevIntegrationServerEndToEnd();

console.log("product agent contract ok");

function testAutomaticMemoryCandidateParserAndPolicy(): void {
  const candidates = parseMemoryCandidates(`\`\`\`json
    {"candidates":[{
      "operation":"create",
      "key":"profile.location.city",
      "text":"User lives in Shanghai",
      "type":"fact",
      "scope":"owner",
      "confidence":0.96,
      "importance":0.8,
      "sensitivity":"normal",
      "evidence":"I live in Shanghai",
      "reason":"Useful for local answers"
    }]}
  \`\`\``);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.sensitivity, "low");
  const accepted = evaluateMemoryCandidate(candidates[0] as MemoryCandidate, {
    latestUserMessage: "I live in Shanghai",
    explicitRequest: false
  }, {
    minConfidence: 0.8,
    minImportance: 0.55
  });
  assert.equal(accepted.accepted, true);

  const weatherOnly = evaluateMemoryCandidate({
    ...(candidates[0] as MemoryCandidate),
    evidence: "Shanghai"
  }, {
    latestUserMessage: "What is the weather in Shanghai today?",
    explicitRequest: false
  }, {
    minConfidence: 0.8,
    minImportance: 0.55
  });
  assert.equal(weatherOnly.accepted, false);
  assert.equal(weatherOnly.reason, "location_not_durable");

  const secret = evaluateMemoryCandidate({
    ...(candidates[0] as MemoryCandidate),
    key: "profile.provider.api",
    text: "API key sk-secret123456",
    evidence: "sk-secret123456",
    sensitivity: "secret"
  }, {
    latestUserMessage: "My API key is sk-secret123456",
    explicitRequest: true
  }, {
    minConfidence: 0.8,
    minImportance: 0.55
  });
  assert.equal(secret.accepted, false);
  assert.equal(secret.reason, "secret_detected");
  const store = new InMemoryThreadMemoryStore();
  assert.throws(() => store.saveMemory("secret-room", {
    text: "API key sk-secret123456"
  }), /credential-like secret/);
  assert.deepEqual(parseMemoryCandidates("not json"), []);
}

function testOwnerMemoryPersistsAcrossThreadsAndRestart(): void {
  const dataDir = mkdtempSync(join(tmpdir(), "direxio-owner-memory-"));
  try {
    const firstStore = new FileBackedThreadMemoryStore({ dataDir, ownerId: "owner-1" });
    const saved = firstStore.saveMemory("owner-file-a", {
      key: "profile.location.city",
      scope: "owner",
      text: "用户常住上海",
      type: "fact",
      source: "automatic_extraction",
      confidence: 0.95,
      importance: 0.8,
      sensitivity: "low",
      evidence: "我常住上海"
    });
    const restartedStore = new FileBackedThreadMemoryStore({ dataDir, ownerId: "owner-1" });
    const visible = restartedStore.listMemories("owner-file-b");
    assert.equal(visible.length, 1);
    assert.equal(visible[0]?.id, saved.id);
    assert.equal(visible[0]?.scope, "owner");
    assert.equal(visible[0]?.confidence, 0.95);
    assert.equal(restartedStore.deleteMemory("owner-file-b", saved.id), true);
    assert.equal(restartedStore.listMemories("owner-file-a").length, 0);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function testDefaultAutomaticMemoryExtractorUsesGatewayJson(): Promise<void> {
  const memoryStore = new InMemoryThreadMemoryStore();
  const tasks: string[] = [];
  const runtime = createLangChainAgentRuntime({
    memoryStore,
    autoMemoryEnabled: true,
    env: {} as NodeJS.ProcessEnv
  });
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    runtime,
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      tasks.push(String(payload.task));
      if (payload.task === "memory_extract") {
        assert.equal(payload.tool_choice, "none");
        return new Response(JSON.stringify({
          reply: JSON.stringify({
            candidates: [memoryCandidate({
              key: "preference.response.length",
              text: "用户偏好简短回复",
              type: "preference",
              evidence: "I prefer concise replies"
            })]
          })
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ reply: "Understood" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await app.ready();
  try {
    const response = await injectJson(app, "/v1/agent/messages", {
      conversation_type: "direxio_ai",
      node_id: "node-1",
      conversation_id: "gateway-memory-a",
      messages: [{ sender: "user", content: "I prefer concise replies" }]
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.reply, "Understood");
    assert.deepEqual(tasks, ["chat", "memory_extract"]);
    const items = memoryStore.listMemories("gateway-memory-b");
    assert.equal(items.length, 1);
    assert.equal(items[0]?.key, "preference.response.length");
    assert.equal(items[0]?.text, "用户偏好简短回复");
  } finally {
    await app.close();
  }
}

async function testLangChainRuntimeAutomaticallyCreatesUpdatesAndDeletesOwnerMemory(): Promise<void> {
  const memoryStore = new InMemoryThreadMemoryStore();
  const extractor: MemoryCandidateExtractor = {
    async extract(input) {
      if (input.latestUserMessage.includes("搬到杭州")) {
        return [memoryCandidate({
          operation: "update",
          text: "用户常住杭州",
          evidence: "我已经搬到杭州"
        })];
      }
      if (input.latestUserMessage.includes("忘记")) {
        return [memoryCandidate({
          operation: "delete",
          text: "",
          evidence: "忘记我住在哪里"
        })];
      }
      if (input.latestUserMessage.includes("API Key")) {
        return [memoryCandidate({
          key: "profile.provider.api",
          text: "API Key sk-secret123456",
          evidence: "API Key 是 sk-secret123456",
          sensitivity: "secret"
        })];
      }
      return [memoryCandidate({
        text: "用户常住上海",
        evidence: "我常住上海"
      })];
    }
  };
  const runtime = createLangChainAgentRuntime({
    memoryStore,
    memoryExtractor: extractor,
    autoMemoryEnabled: true,
    env: {} as NodeJS.ProcessEnv
  });
  let gatewayCalls = 0;
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    runtime,
    fetchImpl: async () => {
      gatewayCalls += 1;
      return new Response(JSON.stringify({ reply: "好的" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await app.ready();
  try {
    const created = await injectJson(app, "/v1/agent/messages", {
      conversation_type: "direxio_ai",
      node_id: "node-1",
      conversation_id: "owner-memory-a",
      messages: [{ sender: "user", content: "我常住上海" }]
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.reply, "好的");
    let items = memoryStore.listMemories("owner-memory-b");
    assert.equal(items.length, 1);
    assert.equal(items[0]?.key, "profile.location.city");
    assert.equal(items[0]?.text, "用户常住上海");
    assert.equal(items[0]?.scope, "owner");

    await injectJson(app, "/v1/agent/messages", {
      conversation_type: "direxio_ai",
      node_id: "node-1",
      conversation_id: "owner-memory-b",
      messages: [{ sender: "user", content: "我已经搬到杭州" }]
    });
    items = memoryStore.listMemories("owner-memory-a");
    assert.equal(items.length, 1);
    assert.equal(items[0]?.text, "用户常住杭州");

    await injectJson(app, "/v1/agent/messages", {
      conversation_type: "direxio_ai",
      node_id: "node-1",
      conversation_id: "owner-memory-a",
      messages: [{ sender: "user", content: "我的 API Key 是 sk-secret123456" }]
    });
    assert.equal(memoryStore.listMemories("owner-memory-a").length, 1);

    await injectJson(app, "/v1/agent/messages", {
      conversation_type: "direxio_ai",
      node_id: "node-1",
      conversation_id: "owner-memory-b",
      messages: [{ sender: "user", content: "忘记我住在哪里" }]
    });
    assert.equal(memoryStore.listMemories("owner-memory-a").length, 0);
    assert.equal(gatewayCalls, 4);
  } finally {
    await app.close();
  }
}

async function testAutomaticMemoryFailureDoesNotBreakOrDuplicateReply(): Promise<void> {
  const runtime = createLangChainAgentRuntime({
    memoryExtractor: {
      async extract() {
        throw new Error("extractor unavailable");
      }
    },
    autoMemoryEnabled: true,
    env: {} as NodeJS.ProcessEnv
  });
  let gatewayCalls = 0;
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    runtime,
    fetchImpl: async () => {
      gatewayCalls += 1;
      return new Response(JSON.stringify({ reply: "single reply" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await app.ready();
  try {
    const response = await injectJson(app, "/v1/agent/messages", {
      conversation_type: "direxio_ai",
      node_id: "node-1",
      conversation_id: "memory-failure-room",
      messages: [{ sender: "user", content: "I live in Shanghai" }]
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.reply, "single reply");
    assert.equal(asRecord(response.body.outbound_message).content, "single reply");
    assert.equal(gatewayCalls, 1);
  } finally {
    await app.close();
  }
}

function memoryCandidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    operation: "create",
    key: "profile.location.city",
    text: "用户常住上海",
    type: "fact",
    scope: "owner",
    confidence: 0.96,
    importance: 0.8,
    sensitivity: "low",
    evidence: "我常住上海",
    reason: "Useful for local answers",
    ...overrides
  };
}

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

async function testGatewayForwardsOpenAIToolDefinitionsAndCalls(): Promise<void> {
  const modelClient = createDefaultModelClient({
    env: {
      DIREXIO_AI_GATEWAY_MODEL_MODE: "openai-compatible",
      DIREXIO_MODEL_API_KEY: "provider_test_key",
      DIREXIO_MODEL_BASE_URL: "http://provider.test/v1",
      DIREXIO_MODEL_NAME: "test-model"
    } as NodeJS.ProcessEnv,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      const tools = body.tools as Array<Record<string, unknown>>;
      const firstTool = asRecord(tools[0]);
      const firstFunction = asRecord(firstTool.function);
      assert.equal(firstFunction.name, "search_current_ai_thread");
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: "",
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: {
                name: "search_current_ai_thread",
                arguments: "{\"query\":\"LangChain\"}"
              }
            }]
          }
        }],
        usage: { total_tokens: 18 }
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
    messages: [{ role: "user", content: "search LangChain" }],
    tools: [{
      type: "function",
      function: {
        name: "search_current_ai_thread",
        parameters: { type: "object" }
      }
    }]
  });
  assert.equal(result.reply, "");
  assert.equal(result.tool_calls?.[0]?.id, "call_1");
  assert.equal(result.tool_calls?.[0]?.name, "search_current_ai_thread");
  assert.deepEqual(result.tool_calls?.[0]?.args, { query: "LangChain" });
}

async function testHostedGatewayTimeout(): Promise<void> {
  const result = await callHostedGateway({
    gatewayUrl: "http://gateway.test",
    aiToken: "dxai_ok",
    timeoutMs: 1,
    payload: {
      node_id: "node-1",
      conversation_id: "ai-room",
      task: "chat",
      model: "default",
      messages: [{ role: "user", content: "hello" }]
    },
    fetchImpl: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      }, { once: true });
    })
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 504);
    assert.equal(result.error.code, "gateway_timeout");
  }
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

async function testDirexioAiTokenGenerator(): Promise<void> {
  const scriptPath = fileURLToPath(new URL("../product-agent/scripts/generate-token.mjs", import.meta.url));
  const output = execFileSync(process.execPath, [scriptPath, "2"], { encoding: "utf8" })
    .trim()
    .split(/\r?\n/);
  assert.equal(output.length, 2);
  assert.match(output[0] || "", /^dxai_[A-Za-z0-9_-]{43}$/);
  assert.match(output[1] || "", /^dxai_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(output[0], output[1]);
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

async function testAgentDefaultsToLangChainRuntime(): Promise<void> {
  const captured: unknown[] = [];
  const app = createProductAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    env: {} as NodeJS.ProcessEnv,
    fetchImpl: async (_url, init) => {
      captured.push(JSON.parse(String(init?.body || "{}")));
      return new Response(JSON.stringify({ reply: "default langchain ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await app.ready();
  try {
    const response = await injectJson(app, "/v1/agent/messages", aiEvent());
    assert.equal(response.status, 200);
    const payload = asRecord(captured[0]);
    assert.equal(Array.isArray(payload.tools), true);
    assert.equal(payload.tool_choice, "auto");
    const messages = payload.messages as Array<Record<string, unknown>>;
    assert.match(String(messages[0]?.content), /You are Direxio AI/);
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

async function testAgentAddsCurrentThreadToolContext(): Promise<void> {
  const captured: unknown[] = [];
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    fetchImpl: async (_url, init) => {
      captured.push(JSON.parse(String(init?.body || "{}")));
      return new Response(JSON.stringify({ reply: "tool-aware reply" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await app.ready();
  try {
    const response = await injectJson(app, "/v1/agent/messages", {
      conversation_type: "direxio_ai",
      node_id: "node-1",
      conversation_id: "ai-room",
      messages: [
        { sender: "user", content: "Alice mentioned LangChain tools" },
        { sender: "user", content: "搜索 LangChain" }
      ]
    });
    assert.equal(response.status, 200);
    const messages = asRecord(captured[0]).messages as Array<Record<string, unknown>>;
    assert.match(String(messages[0]?.content), /Direxio local tool context/);
    assert.match(String(messages[0]?.content), /search_current_ai_thread/);
    assert.match(String(messages[0]?.content), /Alice mentioned LangChain tools/);
  } finally {
    await app.close();
  }
}

function testOfficialExperienceAbilitiesArePrivateByDefault(): void {
  assert.equal(officialExperienceAbilityManifests.length, 3);
  for (const manifest of officialExperienceAbilityManifests) {
    assert.equal(manifest.defaultVisibility, "private");
    assert.equal(manifest.outputKind, "agent_action_result");
    assert.equal(typeof manifest.action, "string");
    assert.equal(manifest.permissions.some((permission) => permission.scope === "current_ai_thread"), true);
    assert.equal(manifest.permissions.some((permission) => permission.scope === "explicit_selected_context"), false);
  }
}

async function testAgentActionMenuEndpoint(): Promise<void> {
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    fetchImpl: async () => {
      throw new Error("gateway should not be called");
    }
  });
  await app.ready();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/v1/agent/actions",
      headers: {}
    });
    const body = response.json() as Record<string, unknown>;
    const items = body.items as Array<Record<string, unknown>>;
    assert.equal(response.statusCode, 200);
    assert.equal(body.schema, "direxio.agent_action_menu.v1");
    assert.equal(items.length, 3);
    assert.deepEqual(items.map((item) => item.action), ["persona_card", "memory_capsule", "mood_card"]);
  } finally {
    await app.close();
  }
}

async function testAgentToolsEndpoint(): Promise<void> {
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    fetchImpl: async () => {
      throw new Error("gateway should not be called");
    }
  });
  await app.ready();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/v1/agent/tools",
      headers: {}
    });
    const body = response.json() as Record<string, unknown>;
    const items = body.items as Array<Record<string, unknown>>;
    const names = items.map((item) => item.name);
    assert.equal(response.statusCode, 200);
    assert.equal(body.schema, "direxio.agent_tools.v1");
    assert.equal(items.every((item) => item.schema === "direxio.agent_tool.v1"), true);
    assert.equal(names.includes("search_current_ai_thread"), true);
    assert.equal(names.includes("web_search"), true);
    assert.equal(names.includes("memory_save"), true);
    assert.equal(names.includes("memory_list"), true);
    assert.equal(names.includes("memory_delete"), true);
    assert.equal(names.includes("create_mood_card"), true);
    const webSearch = items.find((item) => item.name === "web_search");
    const moodCard = items.find((item) => item.name === "create_mood_card");
    assert.equal(webSearch?.defaultEnabled, true);
    assert.equal(moodCard?.source, "official");
    assert.equal(moodCard?.skillKind, "built_in");
    assert.equal(moodCard?.outputKind, "agent_action_result");
    assert.equal(moodCard?.shareable, true);
    assert.equal(Array.isArray(moodCard?.triggerExamples), true);
    assert.equal(asRecord(moodCard?.inputSchema).type, "object");
  } finally {
    await app.close();
  }
}

async function testAgentMemoryEndpointSaveListDelete(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "direxio-agent-memory-api-"));
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    env: { DIREXIO_AGENT_DATA_DIR: dataDir } as NodeJS.ProcessEnv,
    fetchImpl: async () => {
      throw new Error("gateway should not be called");
    }
  });
  await app.ready();
  try {
    const created = await injectJson(app, "/v1/agent/memory", {
      conversation_id: "memory-api-room",
      text: "save card collection idea",
      type: "card_memory",
      source: "agent_card_save",
      tags: ["card", "collection"]
    });
    assert.equal(created.status, 201);
    const item = asRecord(created.body.item);
    assert.equal(item.type, "card_memory");
    assert.equal(item.text, "save card collection idea");

    const listed = await app.inject({
      method: "GET",
      url: "/v1/agent/memory?conversation_id=memory-api-room",
      headers: {}
    });
    const listedBody = listed.json() as Record<string, unknown>;
    const items = listedBody.items as Array<Record<string, unknown>>;
    assert.equal(listed.statusCode, 200);
    assert.equal(listedBody.schema, "direxio.agent_memory_list.v1");
    assert.equal(items.length, 1);
    assert.equal(items[0]?.id, item.id);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/v1/agent/memory/${encodeURIComponent(String(item.id))}?conversation_id=memory-api-room`,
      headers: {}
    });
    const deletedBody = deleted.json() as Record<string, unknown>;
    assert.equal(deleted.statusCode, 200);
    assert.equal(deletedBody.deleted, true);

    const afterDelete = await app.inject({
      method: "GET",
      url: "/v1/agent/memory?conversation_id=memory-api-room",
      headers: {}
    });
    const afterDeleteBody = afterDelete.json() as Record<string, unknown>;
    assert.deepEqual(afterDeleteBody.items, []);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function testAgentPromptSkillEndpointValidateSaveListDeleteAndRestart(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "direxio-agent-skill-api-"));
  const skillInput = {
    title: "Daily Check In",
    description: "Create a short daily reflection from the current AI thread.",
    prompt: "Write a concise daily check-in with one summary and one next action.",
    triggerExamples: ["daily check in", "make my daily reflection"],
    outputKind: "text",
    permissions: [{ scope: "current_ai_thread", access: "read", required: false }],
    enabled: true
  };

  try {
    const firstApp = createAgentServiceApp({
      aiToken: "dxai_ok",
      gatewayUrl: "http://gateway.test",
      env: { DIREXIO_AGENT_DATA_DIR: dataDir } as NodeJS.ProcessEnv,
      fetchImpl: async () => {
        throw new Error("gateway should not be called");
      }
    });
    await firstApp.ready();
    let skillId = "";
    try {
      const invalid = await injectJson(firstApp, "/v1/agent/skills/validate", {
        title: "",
        description: "",
        prompt: "",
        triggerExamples: []
      });
      assert.equal(invalid.status, 200);
      assert.equal(invalid.body.ok, false);
      assert.equal(Array.isArray(invalid.body.errors), true);

      const validated = await injectJson(firstApp, "/v1/agent/skills/validate", skillInput);
      assert.equal(validated.status, 200);
      assert.equal(validated.body.ok, true);
      const validatedSkill = asRecord(validated.body.skill);
      assert.equal(validatedSkill.schema, "direxio.prompt_skill.v1");
      assert.equal(validatedSkill.id, "prompt-daily-check-in");

      const saved = await injectJson(firstApp, "/v1/agent/skills", skillInput);
      assert.equal(saved.status, 201);
      const item = asRecord(saved.body.item);
      skillId = String(item.id);
      assert.equal(skillId, "prompt-daily-check-in");
      assert.equal(item.title, "Daily Check In");

      const listed = await firstApp.inject({
        method: "GET",
        url: "/v1/agent/skills",
        headers: {}
      });
      const listedBody = listed.json() as Record<string, unknown>;
      const items = listedBody.items as Array<Record<string, unknown>>;
      assert.equal(listed.statusCode, 200);
      assert.equal(listedBody.schema, "direxio.prompt_skill_list.v1");
      assert.equal(items.length, 1);
      assert.equal(items[0]?.id, skillId);

      const patched = await firstApp.inject({
        method: "PATCH",
        url: `/v1/agent/skills/${encodeURIComponent(skillId)}`,
        headers: { "Content-Type": "application/json" },
        payload: {
          title: "Daily Card Check In",
          prompt: "Return a compact structured status card.",
          trigger_examples: ["daily card"],
          output_kind: "agent_action_result",
          enabled: false
        }
      });
      const patchedBody = patched.json() as Record<string, unknown>;
      const patchedItem = asRecord(patchedBody.item);
      assert.equal(patched.statusCode, 200);
      assert.equal(patchedBody.schema, "direxio.prompt_skill_item.v1");
      assert.equal(patchedItem.id, skillId);
      assert.equal(patchedItem.title, "Daily Card Check In");
      assert.equal(patchedItem.prompt, "Return a compact structured status card.");
      assert.equal(patchedItem.outputKind, "agent_action_result");
      assert.equal(patchedItem.enabled, false);
      assert.deepEqual(patchedItem.triggerExamples, ["daily card"]);

      const patchedTools = await firstApp.inject({
        method: "GET",
        url: "/v1/agent/tools",
        headers: {}
      });
      const patchedToolsBody = patchedTools.json() as Record<string, unknown>;
      const patchedToolsItems = patchedToolsBody.items as Array<Record<string, unknown>>;
      assert.equal(patchedToolsItems.some((tool) => tool.name === `prompt_skill_${skillId}`), false);

      const invalidPatch = await firstApp.inject({
        method: "PATCH",
        url: `/v1/agent/skills/${encodeURIComponent(skillId)}`,
        headers: { "Content-Type": "application/json" },
        payload: { prompt: "" }
      });
      const invalidPatchBody = invalidPatch.json() as Record<string, unknown>;
      assert.equal(invalidPatch.statusCode, 400);
      assert.equal(errorCode(invalidPatchBody), "invalid_prompt_skill");
    } finally {
      await firstApp.close();
    }

    const secondApp = createAgentServiceApp({
      aiToken: "dxai_ok",
      gatewayUrl: "http://gateway.test",
      env: { DIREXIO_AGENT_DATA_DIR: dataDir } as NodeJS.ProcessEnv,
      fetchImpl: async () => {
        throw new Error("gateway should not be called");
      }
    });
    await secondApp.ready();
    try {
      const listed = await secondApp.inject({
        method: "GET",
        url: "/v1/agent/skills",
        headers: {}
      });
      const listedBody = listed.json() as Record<string, unknown>;
      const items = listedBody.items as Array<Record<string, unknown>>;
      assert.equal(items.length, 1);
      assert.equal(items[0]?.id, skillId);
      assert.equal(items[0]?.title, "Daily Card Check In");
      assert.equal(items[0]?.outputKind, "agent_action_result");
      assert.equal(items[0]?.enabled, false);
      assert.deepEqual(items[0]?.triggerExamples, ["daily card"]);

      const deleted = await secondApp.inject({
        method: "DELETE",
        url: `/v1/agent/skills/${encodeURIComponent(skillId)}`,
        headers: {}
      });
      const deletedBody = deleted.json() as Record<string, unknown>;
      assert.equal(deleted.statusCode, 200);
      assert.equal(deletedBody.deleted, true);
    } finally {
      await secondApp.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function testAgentPromptSkillUploadAppearsInToolsAndTriggers(): Promise<void> {
  const captured: unknown[] = [];
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    fetchImpl: async (_url, init) => {
      captured.push(JSON.parse(String(init?.body || "{}")));
      return new Response(JSON.stringify({ reply: "custom skill reply" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await app.ready();
  try {
    const saved = await injectJson(app, "/v1/agent/skills", {
      title: "Daily Check In",
      description: "Create a short daily reflection from the current AI thread.",
      prompt: "Use a warm tone. Return one sentence summary and one next action.",
      triggerExamples: ["daily check in"],
      outputKind: "text",
      permissions: [{ scope: "current_ai_thread", access: "read", required: false }],
      enabled: true
    });
    assert.equal(saved.status, 201);

    const toolsResponse = await app.inject({
      method: "GET",
      url: "/v1/agent/tools",
      headers: {}
    });
    const toolsBody = toolsResponse.json() as Record<string, unknown>;
    const tools = toolsBody.items as Array<Record<string, unknown>>;
    const customTool = tools.find((tool) => tool.name === "prompt_skill_prompt-daily-check-in");
    assert.equal(customTool?.source, "user");
    assert.equal(customTool?.skillKind, "prompt");
    assert.equal(customTool?.title, "Daily Check In");

    const response = await injectJson(app, "/v1/agent/messages", {
      conversation_type: "direxio_ai",
      node_id: "node-1",
      conversation_id: "prompt-skill-room",
      messages: [{ sender: "user", content: "daily check in for this build" }]
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.reply, "custom skill reply");
    const payload = asRecord(captured[0]);
    const messages = payload.messages as Array<Record<string, unknown>>;
    const context = String(messages[0]?.content);
    assert.match(context, /Prompt Skill: Daily Check In/);
    assert.match(context, /Use a warm tone/);
    assert.match(context, /daily check in for this build/);
  } finally {
    await app.close();
  }
}

async function testAgentPromptSkillSyncEndpointAcceptsPluginConfigShape(): Promise<void> {
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    fetchImpl: async () => {
      throw new Error("gateway should not be called");
    }
  });
  await app.ready();
  try {
    const response = await injectJson(app, "/v1/agent/skills/sync", {
      agent_config: {
        skills: [
          {
            schema: "direxio.prompt_skill.v1",
            kind: "prompt",
            id: "prompt-daily-ritual",
            title: "Daily Ritual",
            description: "Create a compact daily ritual card.",
            prompt: "Summarize the user's current day as one tiny ritual.",
            trigger_examples: ["daily ritual"],
            output_kind: "text",
            permissions: [{ scope: "current_ai_thread", access: "read", required: false }],
            enabled: true
          },
          {
            id: "developer-browser-skill",
            name: "Browser Skill",
            repo_url: "https://github.com/example/skills"
          }
        ]
      }
    });
    assert.equal(response.status, 200);
    const saved = response.body.saved as Array<Record<string, unknown>>;
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.id, "prompt-daily-ritual");
    assert.equal(response.body.skipped, 1);

    const toolsResponse = await app.inject({
      method: "GET",
      url: "/v1/agent/tools",
      headers: {}
    });
    const toolsBody = toolsResponse.json() as Record<string, unknown>;
    const tools = toolsBody.items as Array<Record<string, unknown>>;
    assert.equal(
      tools.some((tool) => tool.name === "prompt_skill_prompt-daily-ritual"),
      true
    );
  } finally {
    await app.close();
  }
}

async function testAgentPromptSkillConfigFromMessageServerEventTriggersWithoutPreupload(): Promise<void> {
  const captured: unknown[] = [];
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    fetchImpl: async (_url, init) => {
      captured.push(JSON.parse(String(init?.body || "{}")));
      return new Response(JSON.stringify({ reply: "ritual reply" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await app.ready();
  try {
    const response = await injectJson(app, "/v1/message-server/new-message", {
      node_id: "node-1",
      room_id: "!agents:example.com",
      conversation_type: "agent",
      sender_kind: "user",
      content: "please make my daily ritual",
      agent_config: {
        skills: [
          {
            schema: "direxio.prompt_skill.v1",
            kind: "prompt",
            id: "prompt-daily-ritual",
            title: "Daily Ritual",
            description: "Create a compact daily ritual card.",
            prompt: "Use the current AI thread and return one calming ritual.",
            trigger_examples: ["daily ritual"],
            output_kind: "text",
            permissions: [{ scope: "current_ai_thread", access: "read", required: false }],
            enabled: true
          }
        ]
      }
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.reply, "ritual reply");
    const payload = asRecord(captured[0]);
    const messages = payload.messages as Array<Record<string, unknown>>;
    const context = String(messages[0]?.content);
    assert.match(context, /Prompt Skill: Daily Ritual/);
    assert.match(context, /one calming ritual/);
    assert.match(context, /please make my daily ritual/);
  } finally {
    await app.close();
  }
}

async function testAgentActionMessageReturnsStructuredCard(): Promise<void> {
  const captured: unknown[] = [];
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    fetchImpl: async (_url, init) => {
      captured.push(JSON.parse(String(init?.body || "{}")));
      return new Response(JSON.stringify({ reply: "status card ready" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await app.ready();
  try {
    const response = await injectJson(app, "/v1/agent/messages", {
      conversation_type: "direxio_ai",
      node_id: "node-1",
      conversation_id: "action-room",
      messages: [
        { sender: "user", content: "remember concise replies in English" },
        { sender: "user", content: "I want to keep this product feeling light." },
        { sender: "user", content: "\u4eca\u65e5\u72b6\u6001\u5361" }
      ]
    });
    assert.equal(response.status, 200);
    assert.equal(captured.length, 1);
    const messages = asRecord(captured[0]).messages as Array<Record<string, unknown>>;
    const context = messages.map((message) => String(message.content || "")).join("\n");
    assert.match(context, /create_mood_card/);
    const outbound = asRecord(response.body.outbound_message);
    const card = JSON.parse(String(outbound.content)) as Record<string, unknown>;
    assert.equal(card.schema, "direxio.agent_action_result.v1");
    assert.equal(card.action, "mood_card");
    assert.equal((card.points as string[]).some((point) => point.includes("response_style")), true);
    assert.equal(card.title, "今日状态卡");
    assert.match(String(card.summary), /当前状态/);
  } finally {
    await app.close();
  }
}

async function testAgentNaturalLanguageCardRequestReturnsStructuredOutbound(): Promise<void> {
  const captured: unknown[] = [];
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    fetchImpl: async (_url, init) => {
      captured.push(JSON.parse(String(init?.body || "{}")));
      return new Response(JSON.stringify({ reply: "已生成今日状态卡。" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await app.ready();
  try {
    const response = await injectJson(app, "/v1/agent/messages", {
      conversation_type: "direxio_ai",
      node_id: "node-1",
      conversation_id: "natural-card-room",
      messages: [
        { sender: "user", content: "我们正在做 agent skill 机制。" },
        { sender: "user", content: "帮我生成今日状态卡" }
      ]
    });
    assert.equal(response.status, 200);
    const messages = asRecord(captured[0]).messages as Array<Record<string, unknown>>;
    assert.match(String(messages[0]?.content), /create_mood_card/);
    const outbound = asRecord(response.body.outbound_message);
    const card = JSON.parse(String(outbound.content)) as Record<string, unknown>;
    assert.equal(card.schema, "direxio.agent_action_result.v1");
    assert.equal(card.action, "mood_card");
    assert.equal(card.title, "今日状态卡");
  } finally {
    await app.close();
  }
}

async function testAgentAddsPersonaCardToolContext(): Promise<void> {
  const captured: unknown[] = [];
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    fetchImpl: async (_url, init) => {
      captured.push(JSON.parse(String(init?.body || "{}")));
      return new Response(JSON.stringify({ reply: "persona card reply" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await app.ready();
  try {
    const response = await injectJson(app, "/v1/agent/messages", {
      conversation_type: "direxio_ai",
      node_id: "node-1",
      conversation_id: "persona-room",
      secret_note: "must not appear in card",
      messages: [
        { sender: "user", content: "I am building an agent with LangChain and MCP tools." },
        { sender: "user", content: "please create a persona card for my agent builder direction" }
      ]
    });
    assert.equal(response.status, 200);
    const messages = asRecord(captured[0]).messages as Array<Record<string, unknown>>;
    const context = String(messages[0]?.content);
    assert.match(String(messages[0]?.content), /create_persona_card/);
    assert.match(context, /数字人格卡/);
    assert.match(context, /重点：Agent 搭建/);
    assert.doesNotMatch(String(messages[0]?.content), /must not appear in card/);
    assert.equal(context.length < 700, true);
    const outbound = asRecord(response.body.outbound_message);
    const card = JSON.parse(String(outbound.content)) as Record<string, unknown>;
    assert.equal(card.schema, "direxio.agent_action_result.v1");
    assert.equal(card.action, "persona_card");
  } finally {
    await app.close();
  }
}

async function testLangChainRuntimeUsesGatewayToolCalls(): Promise<void> {
  const captured: unknown[] = [];
  const runtime = createLangChainAgentRuntime({
    autoMemoryEnabled: false,
    env: {} as NodeJS.ProcessEnv
  });
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    runtime,
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      captured.push(payload);
      if (captured.length === 1) {
        const tools = payload.tools as Array<Record<string, unknown>>;
        assert.equal(tools.some((item) => asRecord(asRecord(item).function).name === "search_current_ai_thread"), true);
        return new Response(JSON.stringify({
          reply: "",
          tool_calls: [{
            id: "call_1",
            name: "search_current_ai_thread",
            args: { query: "LangChain" },
            type: "tool_call"
          }]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      const messages = payload.messages as Array<Record<string, unknown>>;
      assert.equal(messages.some((message) =>
        message.role === "tool" &&
        message.tool_call_id === "call_1" &&
        String(message.content).includes("Alice mentioned LangChain tools")
      ), true);
      return new Response(JSON.stringify({ reply: "final answer from tool" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await app.ready();
  try {
    const response = await injectJson(app, "/v1/agent/messages", {
      conversation_type: "direxio_ai",
      node_id: "node-1",
      conversation_id: "langchain-room",
      messages: [
        { sender: "user", content: "Alice mentioned LangChain tools" },
        { sender: "user", content: "please search LangChain" }
      ]
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.reply, "final answer from tool");
    assert.equal(captured.length, 2);
  } finally {
    await app.close();
  }
}

async function testLangChainRuntimeUsesExperienceCardToolCall(): Promise<void> {
  const captured: unknown[] = [];
  const runtime = createLangChainAgentRuntime({
    autoMemoryEnabled: false,
    env: {} as NodeJS.ProcessEnv
  });
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    runtime,
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      captured.push(payload);
      if (captured.length === 1) {
        const tools = payload.tools as Array<Record<string, unknown>>;
        assert.equal(tools.some((item) => asRecord(asRecord(item).function).name === "create_memory_capsule"), true);
        return new Response(JSON.stringify({
          reply: "",
          tool_calls: [{
            id: "call_memory_1",
            name: "create_memory_capsule",
            args: { focus: "agent plugin ecosystem", limit: 4 },
            type: "tool_call"
          }]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      const messages = payload.messages as Array<Record<string, unknown>>;
      assert.equal(messages.some((message) =>
        message.role === "tool" &&
        message.tool_call_id === "call_memory_1" &&
        String(message.content).includes("\"schema\": \"direxio.agent_action_result.v1\"") &&
        String(message.content).includes("\"action\": \"memory_capsule\"") &&
        String(message.content).includes("\"points\"")
      ), true);
      return new Response(JSON.stringify({ reply: "memory capsule final" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await app.ready();
  try {
    const response = await injectJson(app, "/v1/agent/messages", {
      conversation_type: "direxio_ai",
      node_id: "node-1",
      conversation_id: "experience-langchain-room",
      messages: [
        { sender: "user", content: "We are designing official agent skills and plugin manifests." },
        { sender: "user", content: "Please use an experience tool for this thread." }
      ]
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.reply, "memory capsule final");
    const outbound = asRecord(response.body.outbound_message);
    const card = JSON.parse(String(outbound.content)) as Record<string, unknown>;
    assert.equal(card.schema, "direxio.agent_action_result.v1");
    assert.equal(card.action, "memory_capsule");
    assert.equal(captured.length, 2);
  } finally {
    await app.close();
  }
}

async function testLangChainRuntimeForcesStructuredCardForExplicitCardRequest(): Promise<void> {
  let gatewayCalls = 0;
  const runtime = createLangChainAgentRuntime({
    autoMemoryEnabled: false,
    env: {} as NodeJS.ProcessEnv
  });
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    runtime,
    fetchImpl: async () => {
      gatewayCalls += 1;
      return new Response(JSON.stringify({ reply: "plain text should not be used" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await app.ready();
  try {
    const response = await injectJson(app, "/v1/agent/messages", {
      conversation_type: "direxio_ai",
      node_id: "node-1",
      conversation_id: "direct-card-room",
      messages: [
        { sender: "user", content: "remember concise replies in English" },
        { sender: "user", content: "今日状态卡" }
      ]
    });
    assert.equal(response.status, 200);
    assert.equal(gatewayCalls, 0);
    const outbound = asRecord(response.body.outbound_message);
    const card = JSON.parse(String(outbound.content)) as Record<string, unknown>;
    assert.equal(card.schema, "direxio.agent_action_result.v1");
    assert.equal(card.action, "mood_card");
    assert.equal((card.points as string[]).some((point) => point.includes("response_style")), true);
  } finally {
    await app.close();
  }
}

async function testLangChainRuntimePromotesStructuredFinalReply(): Promise<void> {
  const rawCard = JSON.stringify({
    schema: "direxio.agent_action_result.v1",
    action: "launch_card",
    title: "Launch Card",
    summary: "The thread feels focused and ready to ship.",
    points: ["Memory is persisted", "Prompt Skill upload is wired"],
    nextActions: ["Run the deployed App check"]
  });
  const runtime = createLangChainAgentRuntime({
    autoMemoryEnabled: false,
    env: {} as NodeJS.ProcessEnv
  });
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    runtime,
    fetchImpl: async () => new Response(JSON.stringify({ reply: rawCard }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })
  });
  await app.ready();
  try {
    const response = await injectJson(app, "/v1/agent/messages", {
      conversation_type: "direxio_ai",
      node_id: "node-1",
      conversation_id: "langchain-structured-final-room",
      messages: [{ sender: "user", content: "return a structured launch summary" }]
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.reply, "The thread feels focused and ready to ship.");
    const outbound = asRecord(response.body.outbound_message);
    assert.equal(outbound.conversation_id, "langchain-structured-final-room");
    assert.deepEqual(JSON.parse(String(outbound.content)), JSON.parse(rawCard));
  } finally {
    await app.close();
  }
}

async function testLangChainRuntimeUsesMemorySaveToolCall(): Promise<void> {
  const captured: unknown[] = [];
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    env: { DIREXIO_AGENT_RUNTIME: "langchain" } as NodeJS.ProcessEnv,
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      captured.push(payload);
      if (captured.length === 1) {
        const tools = payload.tools as Array<Record<string, unknown>>;
        assert.equal(tools.some((item) => asRecord(asRecord(item).function).name === "memory_save"), true);
        return new Response(JSON.stringify({
          reply: "",
          tool_calls: [{
            id: "call_memory_save_1",
            name: "memory_save",
            args: { text: "User wants short readable cards", tags: ["ux", "cards"] },
            type: "tool_call"
          }]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      const messages = payload.messages as Array<Record<string, unknown>>;
      assert.equal(messages.some((message) =>
        message.role === "tool" &&
        message.tool_call_id === "call_memory_save_1" &&
        String(message.content).includes("Saved memory")
      ), true);
      return new Response(JSON.stringify({ reply: "memory saved" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await app.ready();
  try {
    const response = await injectJson(app, "/v1/agent/messages", {
      conversation_type: "direxio_ai",
      node_id: "node-1",
      conversation_id: "memory-tool-room",
      messages: [{ sender: "user", content: "please save this UX preference for later" }]
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.reply, "memory saved");
    const listed = await app.inject({
      method: "GET",
      url: "/v1/agent/memory?conversation_id=memory-tool-room",
      headers: {}
    });
    const body = listed.json() as Record<string, unknown>;
    const items = body.items as Array<Record<string, unknown>>;
    assert.equal(items.length, 1);
    assert.equal(items[0]?.text, "User wants short readable cards");
  } finally {
    await app.close();
  }
}

async function testLangChainRuntimeExposesDisabledMcpCurrentThreadTool(): Promise<void> {
  const captured: unknown[] = [];
  const runtime = createLangChainAgentRuntime({
    autoMemoryEnabled: false,
    env: {} as NodeJS.ProcessEnv
  });
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    runtime,
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      captured.push(payload);
      if (captured.length === 1) {
        const tools = payload.tools as Array<Record<string, unknown>>;
        assert.equal(tools.some((item) => asRecord(asRecord(item).function).name === "mcp_current_thread_search"), true);
        return new Response(JSON.stringify({
          reply: "",
          tool_calls: [{
            id: "call_mcp_disabled",
            name: "mcp_current_thread_search",
            args: { query: "MCP", limit: 2 },
            type: "tool_call"
          }]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      const messages = payload.messages as Array<Record<string, unknown>>;
      assert.equal(messages.some((message) =>
        message.role === "tool" &&
        message.tool_call_id === "call_mcp_disabled" &&
        String(message.content).includes("MCP 当前对话搜索暂未开启")
      ), true);
      return new Response(JSON.stringify({ reply: "mcp disabled final" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await app.ready();
  try {
    const response = await injectJson(app, "/v1/agent/messages", {
      conversation_type: "direxio_ai",
      node_id: "node-1",
      conversation_id: "mcp-disabled-room",
      messages: [{ sender: "user", content: "please search MCP notes" }]
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.reply, "mcp disabled final");
    assert.equal(captured.length, 2);
  } finally {
    await app.close();
  }
}

async function testLangChainRuntimeUsesFakeMcpCurrentThreadTool(): Promise<void> {
  const captured: unknown[] = [];
  let mcpInput: CurrentThreadSearchInput | undefined;
  const currentThreadMcpClient: CurrentThreadMcpClient = {
    async searchCurrentThread(input) {
      mcpInput = input;
      assert.deepEqual(Object.keys(input).sort(), ["conversationId", "limit", "nodeId", "query"]);
      return {
        source: "fake-mcp",
        messages: [{ role: "user", content: "Alice shared MCP notes" }]
      };
    }
  };
  const runtime = createLangChainAgentRuntime({
    autoMemoryEnabled: false,
    env: { DIREXIO_AGENT_MCP_CURRENT_THREAD: "1" } as NodeJS.ProcessEnv,
    currentThreadMcpClient
  });
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    runtime,
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      captured.push(payload);
      if (captured.length === 1) {
        return new Response(JSON.stringify({
          reply: "",
          tool_calls: [{
            id: "call_mcp_1",
            name: "mcp_current_thread_search",
            args: { query: "MCP", limit: 3 },
            type: "tool_call"
          }]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      const messages = payload.messages as Array<Record<string, unknown>>;
      assert.equal(messages.some((message) =>
        message.role === "tool" &&
        message.tool_call_id === "call_mcp_1" &&
        String(message.content).includes("Alice shared MCP notes") &&
        String(message.content).includes("source: fake-mcp")
      ), true);
      return new Response(JSON.stringify({ reply: "final from fake mcp" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await app.ready();
  try {
    const response = await injectJson(app, "/v1/agent/messages", {
      conversation_type: "direxio_ai",
      node_id: "node-1",
      conversation_id: "fake-mcp-room",
      selected_context: "selected text must stay in gateway payload only",
      context_authorized: true,
      secret_note: "must not reach mcp client",
      messages: [{ sender: "user", content: "please search MCP notes" }]
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.reply, "final from fake mcp");
    assert.deepEqual(mcpInput, {
      nodeId: "node-1",
      conversationId: "fake-mcp-room",
      query: "MCP",
      limit: 3
    });
    assert.equal(captured.length, 2);
  } finally {
    await app.close();
  }
}

async function testLangChainRuntimeStopsAtModelCallLimit(): Promise<void> {
  const captured: unknown[] = [];
  const runtime = createLangChainAgentRuntime({
    autoMemoryEnabled: false,
    maxModelCalls: 1,
    env: {} as NodeJS.ProcessEnv
  });
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    runtime,
    fetchImpl: async (_url, init) => {
      captured.push(JSON.parse(String(init?.body || "{}")));
      return new Response(JSON.stringify({
        reply: "",
        tool_calls: [{
          id: "call_1",
          name: "search_current_ai_thread",
          args: { query: "LangChain" },
          type: "tool_call"
        }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await app.ready();
  try {
    const response = await injectJson(app, "/v1/agent/messages", {
      conversation_type: "direxio_ai",
      node_id: "node-1",
      conversation_id: "limited-langchain-room",
      messages: [
        { sender: "user", content: "Alice mentioned LangChain tools" },
        { sender: "user", content: "please search LangChain" }
      ]
    });
    assert.equal(response.status, 429);
    assert.equal(errorCode(response.body), "agent_model_call_limit");
    assert.equal(captured.length, 1);
  } finally {
    await app.close();
  }
}

async function testAgentRemembersThreadPreferences(): Promise<void> {
  const captured: unknown[] = [];
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    fetchImpl: async (_url, init) => {
      captured.push(JSON.parse(String(init?.body || "{}")));
      return new Response(JSON.stringify({ reply: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await app.ready();
  try {
    await injectJson(app, "/v1/agent/messages", {
      conversation_type: "direxio_ai",
      node_id: "node-1",
      conversation_id: "memory-room",
      messages: [{ sender: "user", content: "记住我喜欢简短回答" }]
    });
    const response = await injectJson(app, "/v1/agent/messages", {
      conversation_type: "direxio_ai",
      node_id: "node-1",
      conversation_id: "memory-room",
      messages: [{ sender: "user", content: "我喜欢什么回答风格？" }]
    });
    assert.equal(response.status, 200);
    const secondPayload = asRecord(captured[1]);
    const messages = secondPayload.messages as Array<Record<string, unknown>>;
    assert.match(String(messages[0]?.content), /Direxio thread memory/);
    assert.match(String(messages[0]?.content), /response_style: concise/);
  } finally {
    await app.close();
  }
}

async function testAgentPersistsExplicitMemoryAcrossRestart(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "direxio-agent-memory-"));
  const captured: unknown[] = [];
  const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
    captured.push(JSON.parse(String(init?.body || "{}")));
    return new Response(JSON.stringify({ reply: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const firstApp = createAgentServiceApp({
      aiToken: "dxai_ok",
      gatewayUrl: "http://gateway.test",
      env: { DIREXIO_AGENT_DATA_DIR: dataDir } as NodeJS.ProcessEnv,
      fetchImpl
    });
    await firstApp.ready();
    try {
      const response = await injectJson(firstApp, "/v1/agent/messages", {
        conversation_type: "direxio_ai",
        node_id: "node-1",
        conversation_id: "persistent-memory-room",
        messages: [
          { sender: "user", content: "remember concise replies in English" },
          { sender: "user", content: "remember that my project codename is Memory Lab" }
        ]
      });
      assert.equal(response.status, 200);
    } finally {
      await firstApp.close();
    }

    const persisted = JSON.parse(readFileSync(join(dataDir, "memory", "items.json"), "utf8")) as Record<string, unknown>;
    assert.equal(persisted.schema, "direxio.agent_memory_items.v1");
    assert.equal(Array.isArray(persisted.items), true);
    assert.equal((persisted.items as unknown[]).length, 3);

    captured.length = 0;
    const secondApp = createAgentServiceApp({
      aiToken: "dxai_ok",
      gatewayUrl: "http://gateway.test",
      env: { DIREXIO_AGENT_DATA_DIR: dataDir } as NodeJS.ProcessEnv,
      fetchImpl
    });
    await secondApp.ready();
    try {
      const response = await injectJson(secondApp, "/v1/agent/messages", {
        conversation_type: "direxio_ai",
        node_id: "node-1",
        conversation_id: "persistent-memory-room",
        messages: [{ sender: "user", content: "what do you know about my preferences and project?" }]
      });
      assert.equal(response.status, 200);
      const payload = asRecord(captured[0]);
      const messages = payload.messages as Array<Record<string, unknown>>;
      const memoryMessage = String(messages[0]?.content);
      assert.match(memoryMessage, /Direxio thread memory/);
      assert.match(memoryMessage, /response_style: concise/);
      assert.match(memoryMessage, /language: en/);
      assert.match(memoryMessage, /my project codename is Memory Lab/);
    } finally {
      await secondApp.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function testAgentRetrievesVectorMemoryIntoContext(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "direxio-agent-vector-memory-"));
  const capturedGatewayPayloads: unknown[] = [];
  let embeddingCalls = 0;
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes("/embeddings")) {
      embeddingCalls += 1;
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      const inputs = Array.isArray(body.input) ? body.input.map(String) : [String(body.input || "")];
      return new Response(JSON.stringify({
        data: inputs.map((text, index) => ({
          index,
          embedding: text.toLowerCase().includes("onboarding") ? [1, 0, 0] : [0, 1, 0]
        }))
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    capturedGatewayPayloads.push(JSON.parse(String(init?.body || "{}")));
    return new Response(JSON.stringify({ reply: "memory context ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    env: {
      DIREXIO_AGENT_DATA_DIR: dataDir,
      DIREXIO_AGENT_EMBEDDING_BASE_URL: "http://embedding.test/v1",
      DIREXIO_AGENT_EMBEDDING_MODEL: "embed-test",
      DIREXIO_AGENT_EMBEDDING_API_KEY: "embed-ok"
    } as NodeJS.ProcessEnv,
    fetchImpl
  });
  await app.ready();
  try {
    await injectJson(app, "/v1/agent/memory", {
      conversation_id: "vector-memory-room",
      text: "User wants an onboarding checklist before launch.",
      type: "fact",
      tags: ["onboarding"]
    });
    await injectJson(app, "/v1/agent/memory", {
      conversation_id: "vector-memory-room",
      text: "User likes blue interface accents.",
      type: "fact",
      tags: ["style"]
    });
    const response = await injectJson(app, "/v1/agent/messages", {
      conversation_type: "direxio_ai",
      node_id: "node-1",
      conversation_id: "vector-memory-room",
      messages: [{ sender: "user", content: "What should I remember about onboarding?" }]
    });
    assert.equal(response.status, 200);
    assert.equal(embeddingCalls >= 1, true);
    const payload = asRecord(capturedGatewayPayloads[0]);
    const messages = payload.messages as Array<Record<string, unknown>>;
    const memoryMessage = String(messages[0]?.content);
    assert.match(memoryMessage, /Direxio thread memory/);
    assert.match(memoryMessage, /relevant: User wants an onboarding checklist before launch/);
    const vectors = JSON.parse(readFileSync(join(dataDir, "memory", "vectors.json"), "utf8")) as Record<string, unknown>;
    assert.equal(vectors.schema, "direxio.agent_memory_vectors.v1");
    assert.equal(Array.isArray(vectors.items), true);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function testAgentAutoCompactsThreadContextWhenWindowExceeded(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "direxio-agent-auto-compact-"));
  const captured: unknown[] = [];
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    env: {
      DIREXIO_AGENT_DATA_DIR: dataDir,
      DIREXIO_AGENT_CONTEXT_WINDOW_MESSAGES: "4",
      DIREXIO_AGENT_COMPRESSION_CHUNK_MESSAGES: "2",
      DIREXIO_AGENT_AUTO_COMPACT_MEMORY: "1"
    } as NodeJS.ProcessEnv,
    fetchImpl: async (_url, init) => {
      captured.push(JSON.parse(String(init?.body || "{}")));
      return new Response(JSON.stringify({ reply: "compact ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await app.ready();
  try {
    const response = await injectJson(app, "/v1/agent/messages", {
      conversation_type: "direxio_ai",
      node_id: "node-1",
      conversation_id: "compact-memory-room",
      messages: [
        { sender: "user", content: "old context alpha: we chose explicit memory first; API key sk-supersecret1234" },
        { sender: "assistant", content: "I explained explicit memory and vector search." },
        { sender: "user", content: "middle context beta: auto compression is next" },
        { sender: "assistant", content: "We will keep the newest messages live." },
        { sender: "user", content: "new context gamma: what happened earlier?" }
      ]
    });
    assert.equal(response.status, 200);
    const persisted = JSON.parse(readFileSync(join(dataDir, "memory", "items.json"), "utf8")) as Record<string, unknown>;
    const items = persisted.items as Array<Record<string, unknown>>;
    const summary = items.find((item) => item.type === "thread_summary");
    assert.ok(summary);
    assert.equal(summary?.source, "auto_compression");
    assert.match(String(summary?.text), /Compressed earlier thread context/);
    assert.match(String(summary?.text), /old context alpha/);
    assert.match(String(summary?.text), /vector search/);
    assert.doesNotMatch(String(summary?.text), /sk-supersecret1234/);
    assert.match(String(summary?.text), /\[redacted secret\]/);

    const payload = asRecord(captured[0]);
    const messages = payload.messages as Array<Record<string, unknown>>;
    const memoryMessage = String(messages[0]?.content);
    assert.match(memoryMessage, /Direxio thread memory/);
    assert.match(memoryMessage, /Compressed earlier thread context/);
    assert.match(memoryMessage, /old context alpha/);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function testAgentWebSearchIsEnabledByDefault(): Promise<void> {
  const captured: unknown[] = [];
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    fetchImpl: async (url, init) => {
      if (String(url).includes("api.duckduckgo.com")) {
        return new Response(JSON.stringify({
          Heading: "LangChain",
          AbstractText: "LangChain is a framework for building applications with language models.",
          RelatedTopics: [{ Text: "LangGraph supports agent workflows." }]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      captured.push(JSON.parse(String(init?.body || "{}")));
      return new Response(JSON.stringify({ reply: "web enabled" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await app.ready();
  try {
    const response = await injectJson(app, "/v1/agent/messages", {
      conversation_type: "direxio_ai",
      node_id: "node-1",
      conversation_id: "web-room",
      messages: [{ sender: "user", content: "联网搜索 LangChain 最新信息" }]
    });
    assert.equal(response.status, 200);
    const messages = asRecord(captured[0]).messages as Array<Record<string, unknown>>;
    assert.match(String(messages[0]?.content), /web_search/);
    assert.match(String(messages[0]?.content), /LangChain is a framework/);
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

async function testAgentServiceMessageServerEndpointPromotesStructuredModelReply(): Promise<void> {
  const rawCard = JSON.stringify({
    schema: "direxio.agent_action_result.v1",
    action: "mood_card",
    title: "Prompt Skill Card",
    summary: "A user-authored skill returned a visual card.",
    points: ["The reply stays concise", "The UI can render the card"],
    nextActions: ["Share the card"]
  });
  const app = createAgentServiceApp({
    aiToken: "dxai_ok",
    gatewayUrl: "http://gateway.test",
    fetchImpl: async () => new Response(JSON.stringify({ reply: rawCard }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })
  });
  await app.ready();
  try {
    const response = await injectJson(app, "/v1/message-server/new-message", {
      node_id: "node-1",
      room_id: "!agents:example.com",
      conversation_type: "agent",
      sender_kind: "user",
      content: "run my visual prompt skill",
      agent_config: {
        skills: [
          {
            schema: "direxio.prompt_skill.v1",
            kind: "prompt",
            id: "prompt-visual-card",
            title: "Visual Card",
            description: "Return a compact visual card.",
            prompt: "Return a direxio.agent_action_result.v1 card.",
            trigger_examples: ["visual prompt skill"],
            output_kind: "agent_action_result",
            permissions: [],
            enabled: true
          }
        ]
      }
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.reply, "A user-authored skill returned a visual card.");
    const outbound = asRecord(response.body.outbound_message);
    assert.equal(outbound.conversation_id, "!agents:example.com");
    assert.deepEqual(JSON.parse(String(outbound.content)), JSON.parse(rawCard));
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

function testMessageServerAdapterBuildsAgentActionEvent(): void {
  const adapted = toAgentMessageEvent({
    node_id: "node-1",
    conversation_id: "ai-room",
    conversation_type: "direxio_ai",
    sender_kind: "user",
    agent_action: {
      type: "agent_action",
      action: "persona_card",
      focus: "short profile"
    }
  });
  assert.equal("ignored" in adapted, false);
  if ("ignored" in adapted) return;
  assert.equal(adapted.agent_action?.action, "persona_card");
  assert.match(adapted.messages.at(-1)?.content || "", /"type":"agent_action"/);
  assert.match(adapted.messages.at(-1)?.content || "", /"action":"persona_card"/);
}

function testMessageServerAdapterPassesAgentConfig(): void {
  const adapted = toAgentMessageEvent({
    node_id: "node-1",
    room_id: "!agents:example.com",
    conversation_type: "agent",
    sender_kind: "user",
    content: "hello with config",
    agent_config: {
      skills: [
        {
          schema: "direxio.prompt_skill.v1",
          title: "Daily Ritual"
        }
      ]
    }
  });
  assert.equal("ignored" in adapted, false);
  if ("ignored" in adapted) return;
  const config = asRecord(adapted.agent_config);
  const skills = config.skills as Array<Record<string, unknown>>;
  assert.equal(skills[0]?.schema, "direxio.prompt_skill.v1");
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
