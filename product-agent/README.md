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

- `DIREXIO_AGENT_RUNTIME=local` or unset: prepares deterministic local context
  before it calls `ai-gateway`.
- `DIREXIO_AGENT_RUNTIME=langchain`: uses LangChain `createAgent` with the same
  local read-only tools. The model chooses tools from their descriptions, the
  LangChain loop runs those tools locally, and all model calls still go through
  `ai-gateway`.

The LangChain mode uses `DirexioGatewayChatModel`, a small adapter that converts
LangChain messages/tools into the hosted gateway JSON contract. It does not put
DeepSeek/OpenAI provider keys on the self-hosted node.

Current built-in tools are read-only:

- `list_recent_ai_messages`: reads recent messages from the current AI thread.
- `search_current_ai_thread`: searches the current AI thread only.
- `get_thread_memory`: reads explicit preferences remembered in this process.
- `list_contacts`: uses contact data only if message-server includes it.
- `web_search`: disabled by default; set `DIREXIO_AGENT_WEB_SEARCH=1` to enable the public web search adapter.
- `create_persona_card`: creates a private Digital Persona Card from the current AI thread.
- `create_memory_capsule`: creates a private recap card from the current AI thread.
- `create_mood_card`: creates a private mood snapshot card from the current AI thread.
- `mcp_current_thread_search`: disabled by default; searches only the current AI thread through an injected MCP client when `DIREXIO_AGENT_MCP_CURRENT_THREAD=1`.

The first official experience abilities live in `src/lib/abilities`. They are
not a third-party plugin market yet. They are small built-in manifests plus
read-only tools that produce structured card payloads:

- `persona-card`
- `memory-capsule`
- `mood-card`

Each ability is private by default and declares current-thread-only read
permissions. Future mobile work can render the returned
`direxio.agent_experience_card.v1` payloads as native cards.

Thread memory is process-local and scoped by `conversation_id`. It currently
remembers simple explicit preferences such as concise or detailed reply style.
This is not long-term memory yet; production long-term memory should use a
persistent store and user-visible controls.

The tools do not read private human chats by default. Broader message search
should be added through MCP or message-server APIs with explicit policy checks.
The first MCP hook is only a current-thread client interface and test fake; the
default runtime does not connect to a real MCP server yet.

LangChain tool calling requires the hosted `ai-gateway` model provider path to
support OpenAI-compatible `tools` and `tool_calls`. The deterministic echo
gateway can still answer normal chat requests, but it will not select tools.

Runtime safety controls:

- `DIREXIO_AGENT_MAX_MODEL_CALLS`: maximum gateway-backed model calls per
  LangChain agent turn. Defaults to `3`; accepted range is `1` to `10`.
- `DIREXIO_AGENT_GATEWAY_TIMEOUT_MS`: timeout for each product-agent to
  `ai-gateway` call. Defaults to `30000`; accepted range is `1` to `120000`.
- `DIREXIO_AGENT_RUNTIME_LOG=1`: writes lightweight runtime events such as
  model call count, tool name, duration, and status. It does not log message
  content.

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

This endpoint passes the event through the same `POST /v1/message-server/new-message` path that future message-server wiring should call.

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
```

Self-hosted node runtime environment:

```env
DIREXIO_AI_GATEWAY_URL=https://ai.direxio.com
DIREXIO_AI_TOKEN=dxai_xxx
DIREXIO_PRODUCT_AGENT_URL=http://product-agent:8797
```

`DIREXIO_AI_TOKEN` is not a DeepSeek/OpenAI key. It is a Direxio gateway token
issued by the hosted gateway operator. The real provider API key must stay only
on the hosted gateway host.

The example compose file for the hosted side lives at
`deploy/ai-gateway.compose.example.yml`.
