# Product Agent Prototype

This directory contains the product-agent-owned MVP surface for the hosted Direxio AI design. It is intentionally separate from the existing deployer, `cc-connect`, and MCP wiring.

The implementation uses TypeScript, Node.js, and Fastify.

## Scope

Owned here:

- `agent-service`: the self-hosted node service that receives product AI conversation events and calls the hosted gateway.
- `ai-gateway`: the Direxio-hosted service that validates Direxio AI tokens and calls model providers.
- Protocol and error mapping between those two services.

Not owned here:

- Mobile app implementation.
- `message-server` internals.
- Shared deployer orchestration and cloud-init.
- Existing `cc-connect` bridge behavior.
- Existing MCP tooling.

## Local Contract Test

Run the isolated contract test:

```bash
cd product-agent
npm test
```

The test starts in-process HTTP servers and does not call real model providers.

Run the TypeScript checker:

```bash
cd product-agent
npm run check
```

Run the local memory plus Prompt Skill smoke:

```bash
cd product-agent
npm run smoke:memory-skill
```

This starts `agent-service` on an ephemeral localhost port, writes explicit
memory and an uploaded Prompt Skill into a temporary `DIREXIO_AGENT_DATA_DIR`,
restarts the service, verifies both records persisted, then triggers the Prompt
Skill through the message-server handoff endpoint. The local smoke reuses the
same TypeScript runner that the deployed-node smoke calls, so API contract drift
is caught before deployment.

Run the Docker image smoke:

```bash
cd product-agent
npm run smoke:container
```

This builds a local product-agent image, starts a temporary fake AI gateway and
product-agent container, writes memory, syncs a Prompt Skill, restarts the
container, verifies persisted state, then removes the temporary Docker
resources. Set `DIREXIO_PRODUCT_AGENT_SMOKE_SKIP_BUILD=1` to reuse an existing
local image.

Run the deployed-node smoke after starting the `product-agent` compose profile:

```bash
scp -i <key.pem> product-agent/scripts/remote-smoke.sh ubuntu@<public-ip>:/tmp/product-agent-remote-smoke.sh
ssh -i <key.pem> ubuntu@<public-ip> 'cd /var/direxio-message-server && bash /tmp/product-agent-remote-smoke.sh'
```

The remote smoke runs inside the product-agent container. It writes memory,
syncs one Prompt Skill, restarts only `product-agent` by default, verifies both
records still exist, then sends one `/v1/message-server/new-message` event
through the configured AI gateway. It requires a working server-side
`DIREXIO_AI_TOKEN` and a product-agent image built from a version that contains
`dist/bin/remote-smoke-runner.js`. Use `DIREXIO_PRODUCT_AGENT_SMOKE_RESTART=0`
only when you need to skip the restart check. Older deployments may keep the
compose project in `/opt/p2p`; run the smoke from the directory that contains
the active `docker-compose.yml`.

Build the production JavaScript output:

```bash
cd product-agent
npm run build
```

Build the self-hosted `agent-service` container image:

```bash
cd product-agent
docker build -t direxio/product-agent:latest .
```

Build the hosted `ai-gateway` container image:

```bash
cd product-agent
docker build -f Dockerfile.ai-gateway -t ghcr.io/yingsuiai/direxio-ai-gateway:agent-mvp .
```

Generate one or more Direxio AI gateway tokens:

```bash
cd product-agent
npm run token:generate
npm run token:generate -- 3
```

## Prototype Servers

For Windows local development, copy the example env file and use the one-command starter:

```powershell
cd product-agent
Copy-Item .env.local.example .env.local
# Edit .env.local and fill DIREXIO_MODEL_API_KEY for DeepSeek.
powershell -ExecutionPolicy Bypass -File scripts/dev.ps1 -Restart -RunModelCheck
```

Stop local product-agent processes:

```powershell
cd product-agent
powershell -ExecutionPolicy Bypass -File scripts/stop-dev.ps1
```

Start a local gateway with a test token:

```bash
cd product-agent
DIREXIO_AI_GATEWAY_TOKENS=dxai_test npm run dev:ai-gateway
```

By default the local gateway uses the deterministic echo client. To call a real OpenAI-compatible provider, opt in explicitly:

```bash
cd product-agent
DIREXIO_AI_GATEWAY_TOKENS=dxai_test \
DIREXIO_AI_GATEWAY_MODEL_MODE=openai-compatible \
DIREXIO_AI_GATEWAY_DEBUG_PROVIDER=1 \
DIREXIO_MODEL_API_KEY=<provider-api-key> \
DIREXIO_MODEL_BASE_URL=https://api.openai.com/v1 \
DIREXIO_MODEL_NAME=gpt-4.1-mini \
npm run dev:ai-gateway
```

`DIREXIO_AI_GATEWAY_DEBUG_PROVIDER=1` is for local diagnostics only. It returns the provider HTTP status and a sanitized provider error body when the model call fails.

Start a local agent service that uses that gateway:

```bash
cd product-agent
DIREXIO_AI_TOKEN=dxai_test \
DIREXIO_AI_GATEWAY_URL=http://127.0.0.1:8787 \
npm run dev:agent-service
```

The prototype `agent-service` accepts normalized product AI conversation events at:

```http
POST /v1/agent/messages
Content-Type: application/json
```

It also accepts message-server-shaped new-message events at:

```http
POST /v1/message-server/new-message
Content-Type: application/json
```

The direct message-server endpoint accepts both the hosted-agent contract value
`conversation_type: "direxio_ai"` and the current message-server product kind
`conversation_type: "agent"`. Both paths forward only AI conversation messages,
plus explicitly authorized selected context, to the hosted gateway.

## Local Tools And Thread Memory

`agent-service` has two runtime modes:

- `DIREXIO_AGENT_RUNTIME=langchain` or unset: the intended product path. It uses
  LangChain `createAgent` with the same
  local read-only tools. The model chooses tools from their descriptions, the
  LangChain loop runs those tools locally, and all model calls still go through
  `ai-gateway`.
- `DIREXIO_AGENT_RUNTIME=local`: prepares deterministic local context before it
  calls `ai-gateway`; keep this for tests and cheap smoke checks.

The LangChain mode uses `DirexioGatewayChatModel`, a small adapter that converts
LangChain messages/tools into the hosted gateway JSON contract. It does not put
DeepSeek/OpenAI provider keys on the self-hosted node.

Current built-in tools are scoped to the current AI thread:

- `list_recent_ai_messages`: reads recent messages from the current AI thread.
- `search_current_ai_thread`: searches the current AI thread only.
- `get_thread_memory`: reads explicit preferences remembered in the current AI thread.
- `memory_search`: searches relevant long-term memories for the current AI thread.
- `memory_list`: lists explicit memories for the current AI thread.
- `memory_save`: saves one explicit memory for the current AI thread.
- `memory_delete`: deletes one explicit memory from the current AI thread by id.
- `list_contacts`: uses contact data only if message-server includes it.
- `web_search`: calls the authenticated Direxio hosted-search endpoint for current public information; set `DIREXIO_AGENT_WEB_SEARCH=0` to disable it.
- `create_persona_card`: creates a private Digital Persona Card from the current AI thread.
- `create_memory_capsule`: creates a private recap card from the current AI thread.
- `create_mood_card`: creates a private mood snapshot card from the current AI thread.
- `mcp_current_thread_search`: disabled by default; searches only the current AI thread through an injected MCP client when `DIREXIO_AGENT_MCP_CURRENT_THREAD=1`.

The first official experience abilities live in `src/lib/abilities`. They are
not a third-party plugin market yet. They are small built-in manifests plus
read-only tools that produce compact structured action results:

- `persona-card`
- `memory-capsule`
- `mood-card`

Each ability is private by default and declares current-thread-only read
permissions. App surfaces can fetch the button menu from:

```http
GET /v1/agent/actions
```

The endpoint returns `direxio.agent_action_menu.v1`. When the user taps a
button, message-server can forward a structured action in the AI room event.
Product-agent treats that action as a built-in skill/tool invocation instead of
as a separate hard-coded card path:

```json
{
  "agent_action": {
    "type": "agent_action",
    "action": "persona_card"
  }
}
```

Supported actions are `persona_card`, `memory_capsule`, and `mood_card`.
Tools return `direxio.agent_action_result.v1` with one summary, up to three
points, and one or two next actions so the chat reply stays short.

Thread memory has two layers:

- Recent messages are process-local and scoped by `conversation_id`.
- Explicit user memories can persist when `DIREXIO_AGENT_DATA_DIR` is set.
- When auto compaction is enabled, older recent messages are compressed into a
  persistent `thread_summary` memory after the thread exceeds the configured
  context window.

Persistent memory is stored at:

```text
$DIREXIO_AGENT_DATA_DIR/memory/items.json
```

When the agent prepares a reply, it searches relevant persistent memories and
injects the best matches into the model context. If embedding settings are
available, product-agent writes a local vector index at:

```text
$DIREXIO_AGENT_DATA_DIR/memory/vectors.json
```

Embedding is optional. Without it, product-agent falls back to a local hash
vector so memory search still works without extra infrastructure. To use an
OpenAI-compatible embedding endpoint, set:

```env
DIREXIO_AGENT_EMBEDDING_BASE_URL=https://api.example.com/v1
DIREXIO_AGENT_EMBEDDING_MODEL=text-embedding-3-small
DIREXIO_AGENT_EMBEDDING_API_KEY=...
```

Automatic memory adds a separate post-reply pipeline for ordinary Agent-thread
messages. A gateway-backed extractor proposes structured candidates, then local
deterministic policy checks evidence, confidence, importance, sensitivity, and
credential patterns before anything is written. Accepted owner-scoped memories
use stable keys such as `profile.location.city`, so later corrections update one
canonical item and forget requests soft-delete it. The pipeline is best-effort:
it never creates a second chat message and extraction failure cannot turn a
successful reply into an error.

Automatic memory still does not read or save human chats outside the Agent
thread. Credential-like secrets are rejected by automatic extraction, explicit
memory saves, and the memory API/tool path. Context compaction redacts them
before writing a summary.

Automatic memory is controlled by:

```env
DIREXIO_AGENT_AUTO_MEMORY=1
DIREXIO_AGENT_AUTO_MEMORY_MIN_CONFIDENCE=0.80
DIREXIO_AGENT_AUTO_MEMORY_MIN_IMPORTANCE=0.55
DIREXIO_AGENT_AUTO_MEMORY_MAX_CANDIDATES=3
DIREXIO_AGENT_AUTO_MEMORY_TIMEOUT_MS=5000
```

The extractor adds one short gateway model call after a successful normal
LangChain reply. Set `DIREXIO_AGENT_AUTO_MEMORY=0` to disable it. Existing
explicit memory commands, direct memory API calls, `memory_save` tool calls,
card saves, and context-window compaction remain available.

Auto compaction is controlled by:

```env
DIREXIO_AGENT_AUTO_COMPACT_MEMORY=1
DIREXIO_AGENT_CONTEXT_WINDOW_MESSAGES=30
DIREXIO_AGENT_COMPRESSION_CHUNK_MESSAGES=12
```

When `recentMessages` grows past `DIREXIO_AGENT_CONTEXT_WINDOW_MESSAGES`,
product-agent summarizes the oldest
`DIREXIO_AGENT_COMPRESSION_CHUNK_MESSAGES` messages into a `thread_summary`
memory with source `auto_compression`, trims those old messages from short-term
context, and lets vector memory retrieval recall the summary later. Set
`DIREXIO_AGENT_AUTO_COMPACT_MEMORY=0` to keep the old trim-only behavior.

Local/service memory endpoints:

```http
GET /v1/agent/memory?conversation_id=<conversation_id>
POST /v1/agent/memory
DELETE /v1/agent/memory/<memory_id>?conversation_id=<conversation_id>
```

The POST body is:

```json
{
  "conversation_id": "ai-room",
  "text": "User prefers short readable cards",
  "type": "fact",
  "tags": ["cards"]
}
```

Prompt Skills are user-uploaded prompt-only abilities. They are data, not code,
and are stored at:

```text
$DIREXIO_AGENT_DATA_DIR/skills/prompt-skills.json
```

Local/service Prompt Skill endpoints:

```http
GET /v1/agent/skills
POST /v1/agent/skills/validate
POST /v1/agent/skills
POST /v1/agent/skills/sync
PATCH /v1/agent/skills/<skill_id>
DELETE /v1/agent/skills/<skill_id>
```

The POST body is:

```json
{
  "title": "Daily Check In",
  "description": "Create a short daily reflection from the current AI thread.",
  "prompt": "Write a concise daily check-in with one summary and one next action.",
  "triggerExamples": ["daily check in", "make my daily reflection"],
  "outputKind": "text",
  "permissions": [
    { "scope": "current_ai_thread", "access": "read", "required": false }
  ],
  "enabled": true
}
```

The current implementation validates, stores, lists, deletes, registers, and
triggers enabled Prompt Skills. Each enabled skill appears in `GET
/v1/agent/tools` as a `skillKind: "prompt"` tool. When the user's latest message
matches a `triggerExamples` phrase, product-agent injects the skill prompt as
local tool context for the model. Prompt Skills still do not execute arbitrary
code.

`PATCH /v1/agent/skills/<skill_id>` accepts the same fields as a partial
update. The route id is preserved, and the merged skill must still pass the
normal Prompt Skill validator before it is saved.

`POST /v1/agent/skills/sync` accepts the same Prompt Skill entries either as a
direct `skills` array or inside an official Agent plugin config shape such as:

```json
{
  "agent_config": {
    "skills": [
      {
        "schema": "direxio.prompt_skill.v1",
        "kind": "prompt",
        "id": "prompt-daily-check-in",
        "title": "Daily Check In",
        "description": "Create a short daily reflection.",
        "prompt": "Return one summary and one next action.",
        "trigger_examples": ["daily check in"],
        "output_kind": "text",
        "permissions": [
          { "scope": "current_ai_thread", "access": "read", "required": false }
        ],
        "enabled": true
      }
    ]
  }
}
```

The same config shape may be included on `/v1/message-server/new-message` as
`agent_config`. Product-agent upserts valid Prompt Skills before running the
turn, so a freshly uploaded Prompt Skill can trigger without a separate manual
upload call. Non-prompt developer skill entries are skipped.

The tools do not read private human chats by default. When read-only MCP is
explicitly enabled, product-agent starts the published `dirextalk-mcp` server
over stdio and exposes a fixed allowlist: contacts, rooms, messages, members,
channel posts, and post comments. The latest user turn must explicitly request
the matching App data before the local policy permits a call. Product-agent
never dynamically imports the MCP server's write tools.

MCP evidence is reduced before it is sent through the hosted AI gateway. Raw
MCP JSON is not emitted as an App message, and MCP-derived third-party facts do
not enter automatic canonical memory. After a conversation uses MCP App data,
context overflow is trimmed instead of persisted as a `thread_summary`, so an
old MCP answer cannot later enter the vector memory index through compression.
Because the current Agent token also
authorizes Message Server command actions, this client allowlist protects the
model-facing surface but is not a server-side least-privilege credential. A
future Message Server change should issue a query-only scoped token.

LangChain tool calling requires the hosted `ai-gateway` model provider path to
support OpenAI-compatible `tools` and `tool_calls`. The deterministic echo
gateway can still answer normal chat requests, but it will not select tools.

Runtime safety controls:

- `DIREXIO_AGENT_DATA_DIR`: enables file-backed explicit memory. Leave unset for
  process-local memory only.
- `DIREXIO_AGENT_AUTO_MEMORY`: enables model-assisted candidate extraction plus
  local policy and canonical-key reconciliation. Defaults to `1`.
- `DIREXIO_AGENT_AUTO_MEMORY_MIN_CONFIDENCE` and
  `DIREXIO_AGENT_AUTO_MEMORY_MIN_IMPORTANCE`: reject low-confidence or low-value
  automatic candidates. Defaults are `0.80` and `0.55`.
- `DIREXIO_AGENT_AUTO_MEMORY_MAX_CANDIDATES`: maximum candidate operations per
  turn. Defaults to `3`.
- `DIREXIO_AGENT_AUTO_MEMORY_TIMEOUT_MS`: independent extraction-call timeout.
  Defaults to `5000`.
- `DIREXIO_AGENT_AUTO_COMPACT_MEMORY`: enables context-window compaction into
  `thread_summary` memories. Defaults to `1`.
- `DIREXIO_AGENT_CONTEXT_WINDOW_MESSAGES`: recent-message window before
  compaction. Defaults to `30`.
- `DIREXIO_AGENT_COMPRESSION_CHUNK_MESSAGES`: number of oldest messages to
  compress when the window is exceeded. Defaults to `12`.
- `DIREXIO_AGENT_EMBEDDING_BASE_URL`, `DIREXIO_AGENT_EMBEDDING_MODEL`, and
  `DIREXIO_AGENT_EMBEDDING_API_KEY`: optional OpenAI-compatible embeddings for
  long-term memory retrieval. If unset or failing, local hash vectors are used.
- `DIREXIO_AGENT_MAX_MODEL_CALLS`: maximum gateway-backed model calls per
  LangChain agent turn. Defaults to `3`; accepted range is `1` to `10`.
- `DIREXIO_AGENT_GATEWAY_TIMEOUT_MS`: timeout for each product-agent to
  `ai-gateway` call. Defaults to `30000`; accepted range is `1` to `120000`.
- `DIREXIO_AGENT_RUNTIME_LOG=1`: writes lightweight runtime events such as
  model call count, tool name, duration, and status. It does not log message
  content.
- `DIREXIO_AGENT_MCP_READ_ONLY=1`: enables the fixed read-only MCP tool set.
  It defaults to `0` and is fail-closed when domain or Agent token is missing.
- `DIREXIO_AGENT_MCP_DOMAIN`: Message Server origin used by the MCP child. In
  Docker this is normally `http://message-server:8008`.
- `DIREXIO_AGENT_TOKEN` and `DIREXIO_AGENT_ROOM_ID`: protected node values used
  only by the server-side MCP child. They must never be sent to the App or AI
  gateway.
- `DIREXIO_AGENT_MCP_TIMEOUT_MS`: per-call MCP timeout, default `8000`.

## Dev Integration Server

Run a local message-server handoff simulation:

```bash
cd product-agent
DIREXIO_AI_TOKEN=dxai_test \
DIREXIO_AI_GATEWAY_URL=http://127.0.0.1:8787 \
npm run dev:integration
```

Send a simulated message-server event:

```http
POST /dev/message-server/new-message
Content-Type: application/json
```

This endpoint passes the event through the same
`POST /v1/message-server/new-message` path used by the message-server
product-agent bridge.

## Hosted AI Gateway MVP

The hosted gateway is the Direxio-operated service behind `https://ai.direxio.com`.
It owns the real model provider key and validates Direxio-issued `dxai_...`
tokens. Self-hosted customer servers only receive the Direxio token.

Gateway runtime environment:

```env
DIREXIO_AI_GATEWAY_TOKENS=dxai_xxx,dxai_yyy
DIREXIO_AI_GATEWAY_MODEL_MODE=openai-compatible
DIREXIO_MODEL_BASE_URL=https://api.deepseek.com/v1
DIREXIO_MODEL_API_KEY=<provider-api-key>
DIREXIO_MODEL_NAME=deepseek-chat
TAVILY_API_KEY=<tavily-api-key>
DIREXIO_SEARCH_REQUESTS_PER_MINUTE=60
```

Self-hosted node runtime environment:

```env
DIREXIO_AI_GATEWAY_URL=https://ai.direxio.com
DIREXIO_AI_TOKEN=dxai_xxx
DIREXIO_PRODUCT_AGENT_URL=http://product-agent:8797
DIREXIO_AGENT_DATA_DIR=/var/lib/direxio-product-agent
DIREXIO_AGENT_RUNTIME=langchain
DIREXIO_AGENT_WEB_SEARCH=1
DIREXIO_AGENT_MCP_READ_ONLY=0
DIREXIO_AGENT_MCP_DOMAIN=http://message-server:8008
DIREXIO_AGENT_TOKEN=
DIREXIO_AGENT_ROOM_ID=
DIREXIO_AGENT_MCP_TIMEOUT_MS=8000
DIREXIO_AGENT_TASK_CONTROL=1
DIREXIO_AGENT_PENDING_TASK_TTL_MINUTES=10
DIREXIO_AGENT_DYNAMIC_CARDS=1
DIREXIO_AGENT_PROACTIVE_CARDS=1
DIREXIO_AGENT_CARD_COOLDOWN_MINUTES=360
```

`DIREXIO_AI_TOKEN` is not a DeepSeek/OpenAI key. It is a Direxio gateway token
issued by the hosted gateway operator. The real provider API key must stay only
on the hosted gateway host. `TAVILY_API_KEY` follows the same rule: it is never
copied to a self-hosted node. Task control classifies evidence requirements,
executes required search before answer generation, and rejects promise-only
answers while preserving one final App message.

Official cards use a built-in Adaptive Card Skill. A local planner decides
whether a card is valuable, selects `mood_card`, `memory_capsule`, or
`persona_card`, and enforces proactive-card cooldown. Only then does the skill
ask the hosted model to write card content from redacted current-thread context
and approved memory. TypeScript validates the result and falls back to the
existing deterministic card template on any malformed or unavailable model
response. The App continues to receive only `direxio.agent_action_result.v1`.

The example compose file for the hosted side lives at
`deploy/ai-gateway.compose.example.yml`.
