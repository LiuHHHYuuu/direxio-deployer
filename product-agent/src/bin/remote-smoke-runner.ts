import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "http://127.0.0.1:8797";
const SMOKE_MEMORY_TEXT = "Remote smoke memory: the user prefers concise status cards and saveable skills.";
const SMOKE_TRIGGER = "remote-smoke";
const CONFIG_ONLY_TRIGGER = "agent-config-only-smoke";

export interface SmokeOptions {
  baseUrl: string;
  smokeId: string;
  phase: "write" | "verify";
}

interface SmokeIdentity {
  conversationId: string;
  skillId: string;
  configOnlySkillId: string;
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  });
}

/**
 * Function: Runs one deployed product-agent smoke phase from inside the container.
 * Inputs:
 * - PRODUCT_AGENT_SMOKE_URL: Agent-service base URL, defaults to localhost.
 * - PRODUCT_AGENT_SMOKE_ID: Stable id shared between write and verify phases.
 * - PRODUCT_AGENT_SMOKE_PHASE: Either `write` or `verify`.
 * Output:
 * - Logs one concise success line for the selected phase.
 * Side effects:
 * - Calls product-agent HTTP endpoints and may trigger one real gateway-backed agent turn.
 * Errors:
 * - Throws when an endpoint shape, persistence check, or live agent reply is invalid.
 */
async function main(): Promise<void> {
  const options = smokeOptionsFromEnv(process.env);
  if (options.phase === "write") {
    await writeState(options);
    return;
  }
  await verifyState(options);
}

/**
 * Function: Writes the state that should survive a product-agent restart.
 * Inputs:
 * - options: Base URL plus stable smoke id for this deployed check.
 * Output:
 * - Persists one memory item and one Prompt Skill.
 * Side effects:
 * - Writes to the configured product-agent memory and Prompt Skill stores.
 * Errors:
 * - Throws when product-agent is not ready or the Prompt Skill is not saved.
 */
export async function writeState(options: SmokeOptions): Promise<void> {
  const identity = identityForSmoke(options.smokeId);
  await waitUntilReady(options.baseUrl);
  await request(options.baseUrl, "/v1/agent/memory", {
    method: "POST",
    body: JSON.stringify({
      conversation_id: identity.conversationId,
      text: SMOKE_MEMORY_TEXT,
      type: "preference",
      tags: ["remote-smoke"],
      source: "user_explicit"
    })
  });

  const syncResult = await request(options.baseUrl, "/v1/agent/skills/sync", {
    method: "POST",
    body: JSON.stringify({
      skills: [smokeSkill(identity.skillId)]
    })
  });
  assert(Array.isArray(syncResult.saved) && syncResult.saved.length === 1, "prompt skill sync did not save one skill");
  console.log(`wrote memory and prompt skill for ${identity.conversationId}`);
}

/**
 * Function: Verifies persisted state and one live model-backed agent turn.
 * Inputs:
 * - options: Base URL plus the same stable smoke id used during write.
 * Output:
 * - Confirms memory, Prompt Skill, and outbound agent reply are available.
 * Side effects:
 * - Sends one `/v1/message-server/new-message` event through product-agent.
 * Errors:
 * - Throws when persisted state is missing or the agent reply is empty.
 */
export async function verifyState(options: SmokeOptions): Promise<void> {
  const identity = identityForSmoke(options.smokeId);
  await waitUntilReady(options.baseUrl);

  const memory = await request(
    options.baseUrl,
    `/v1/agent/memory?conversation_id=${encodeURIComponent(identity.conversationId)}`
  );
  assert(Array.isArray(memory.items), "memory endpoint did not return items");
  assert(
    memory.items.some((item) => asString(asRecord(item).text).includes("Remote smoke memory")),
    "persisted memory was not found"
  );

  const skills = await request(options.baseUrl, "/v1/agent/skills");
  assert(Array.isArray(skills.items), "skills endpoint did not return items");
  assert(
    skills.items.some((item) => asRecord(item).id === identity.skillId),
    "persisted prompt skill was not found"
  );

  const event = await request(options.baseUrl, "/v1/message-server/new-message", {
    method: "POST",
    body: JSON.stringify({
      node_id: "remote-smoke-node",
      room_id: identity.conversationId,
      conversation_type: "agent",
      sender_kind: "user",
      content: `Please trigger ${SMOKE_TRIGGER} and return one short confirmation sentence.`,
      agent_config: {
        skills: [smokeSkill(identity.skillId)]
      }
    })
  });
  assert(asString(event.reply).trim(), "agent reply was empty");
  assert(asRecord(event.outbound_message).content, "outbound message was empty");

  await verifyAgentConfigOnlySkill(options.baseUrl, identity);

  console.log(`verified memory, prompt skill, config-only skill, and live model response for ${identity.conversationId}`);
}

/**
 * Function: Verifies the App-shaped path where a newly uploaded Prompt Skill is
 * carried on the message-server event instead of pre-synced through the API.
 * Inputs:
 * - baseUrl: Product-agent service URL.
 * - identity: Stable smoke ids for conversation and skill names.
 * Output:
 * - Confirms product-agent saved the config-only Prompt Skill and replied.
 * Side effects:
 * - Sends one message-server event and writes one Prompt Skill through
 *   `agent_config.skills`.
 * Errors:
 * - Throws when the reply is empty or the config-only skill was not stored.
 */
async function verifyAgentConfigOnlySkill(baseUrl: string, identity: SmokeIdentity): Promise<void> {
  const event = await request(baseUrl, "/v1/message-server/new-message", {
    method: "POST",
    body: JSON.stringify({
      node_id: "remote-smoke-node",
      room_id: identity.conversationId,
      conversation_type: "agent",
      sender_kind: "user",
      content: `Please trigger ${CONFIG_ONLY_TRIGGER} and confirm this skill came from agent_config.`,
      agent_config: {
        skills: [configOnlySmokeSkill(identity.configOnlySkillId)]
      }
    })
  });
  assert(asString(event.reply).trim(), "config-only prompt skill reply was empty");
  assert(asRecord(event.outbound_message).content, "config-only prompt skill outbound message was empty");

  const skills = await request(baseUrl, "/v1/agent/skills");
  assert(Array.isArray(skills.items), "skills endpoint did not return items after config-only event");
  assert(
    skills.items.some((item) => asRecord(item).id === identity.configOnlySkillId),
    "config-only prompt skill from agent_config was not saved"
  );
}

/**
 * Function: Waits for agent-service to accept simple HTTP requests.
 * Inputs:
 * - baseUrl: Product-agent service URL.
 * Output:
 * - Resolves once `/v1/agent/tools` succeeds.
 * Side effects:
 * - Performs repeated HTTP GET requests for up to roughly 30 seconds.
 * Errors:
 * - Throws the last readiness error after all retries fail.
 */
async function waitUntilReady(baseUrl: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await request(baseUrl, "/v1/agent/tools");
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError || new Error("product-agent did not become ready");
}

/**
 * Function: Sends one JSON request to product-agent and validates the HTTP status.
 * Inputs:
 * - baseUrl: Product-agent service URL.
 * - path: Absolute HTTP path beginning with `/`.
 * - options: Fetch options such as method and body.
 * Output:
 * - Parsed JSON object or `{ raw }` for non-JSON text.
 * Side effects:
 * - Performs one HTTP request.
 * Errors:
 * - Throws when the response status is not 2xx.
 */
async function request(baseUrl: string, path: string, options: RequestInit = {}): Promise<Record<string, unknown>> {
  const headers = new Headers(options.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers
  });
  const text = await response.text();
  const body = parseResponseBody(text);
  if (!response.ok) {
    const details = body ? JSON.stringify(body) : text;
    throw new Error(`${options.method || "GET"} ${path} failed: ${response.status} ${details}`);
  }
  return body || {};
}

function smokeOptionsFromEnv(env: NodeJS.ProcessEnv): SmokeOptions {
  const phase = env.PRODUCT_AGENT_SMOKE_PHASE === "write" ? "write" : "verify";
  return {
    baseUrl: stripTrailingSlash(env.PRODUCT_AGENT_SMOKE_URL || DEFAULT_BASE_URL),
    smokeId: env.PRODUCT_AGENT_SMOKE_ID || `remote-smoke-${Date.now()}`,
    phase
  };
}

function identityForSmoke(smokeId: string): SmokeIdentity {
  const cleanId = smokeId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 48) || "remote-smoke";
  return {
    conversationId: cleanId,
    skillId: `prompt-${cleanId}`,
    configOnlySkillId: `prompt-${cleanId}-config-only`
  };
}

function smokeSkill(skillId: string): Record<string, unknown> {
  return {
    schema: "direxio.prompt_skill.v1",
    kind: "prompt",
    id: skillId,
    title: "Remote Smoke Status Card",
    description: "Verifies that a deployed product-agent can load an uploaded Prompt Skill.",
    prompt: "Reply in no more than three short sentences and mention that the remote smoke skill was loaded.",
    trigger_examples: [SMOKE_TRIGGER],
    output_kind: "text",
    permissions: [{ scope: "current_ai_thread", access: "read", required: false }],
    enabled: true
  };
}

function configOnlySmokeSkill(skillId: string): Record<string, unknown> {
  return {
    schema: "direxio.prompt_skill.v1",
    kind: "prompt",
    id: skillId,
    title: "Agent Config Only Smoke",
    description: "Verifies a freshly uploaded Prompt Skill can travel through agent_config.skills.",
    prompt: "Reply in one sentence and mention that the config-only Prompt Skill was loaded.",
    trigger_examples: [CONFIG_ONLY_TRIGGER],
    output_kind: "text",
    permissions: [{ scope: "current_ai_thread", access: "read", required: false }],
    enabled: true
  };
}

function parseResponseBody(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return { raw: text };
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, "");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
}
