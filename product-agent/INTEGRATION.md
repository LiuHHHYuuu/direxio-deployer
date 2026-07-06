# Product Agent Integration Handoff

This file describes how the product agent connects to the rest of Direxio. It is intentionally scoped to the product-agent handoff and the minimal message-server bridge; it does not change mobile, MCP, or cc-connect behavior.

## Current State

`product-agent` can run and pass its local contract tests. A compatible `message-server` build can reach it when `DIREXIO_PRODUCT_AGENT_URL` is configured.

The working pieces are:

- `agent-service`: accepts product AI conversation events at `POST /v1/agent/messages`.
- `ai-gateway`: accepts hosted model requests at `POST /v1/chat`.
- Runtime modes: default local context preparation, plus opt-in LangChain tool-calling with `DIREXIO_AGENT_RUNTIME=langchain`.
- Contract tests: verify privacy gating, token setup failures, gateway errors, hosted tool-call forwarding, LangChain tool execution, and successful replies.

## Fit With Current YingSuiAI Repositories

Checked against `YingSuiAI/direxio-message-server` and `YingSuiAI/direxio-flutter`:

- `message-server` already creates and exposes an agent room through `agent_room_id` in `sync.bootstrap`.
- `message-server` uses the product conversation kind `agent`; `product-agent` accepts that native kind at `/v1/message-server/new-message` and normalizes it to the internal `direxio_ai` gateway contract.
- `message-server` already has a Matrix transport path that can send messages as `@agent:<domain>` when using the agent gateway marker.
- Flutter already has a contacts entry and home/chat handling for the agent room. It opens the normal `/chat/<roomId>` route and sends normal Matrix text messages.
- The minimal server-side bridge is implemented in `message-server`: it detects new user messages in the agent room, calls `agent-service`, and writes the returned reply as `@agent:<domain>`.

## What Must Change Before New Accounts Can Use It

New account usability is split across these surfaces:

- Mobile app: no obvious MVP blocker found; it already treats the agent room as a special friend/conversation.
- `message-server`: forward user messages from the existing agent room to `agent-service`.
- `message-server`: write the returned AI reply back into the same AI conversation.
- Deployer/runtime orchestration: start `agent-service` next to the self-hosted backend and provide `DIREXIO_AI_TOKEN`.
- Hosted operations: issue and rotate `DIREXIO_AI_TOKEN` values for self-hosted nodes.

## Recommended Minimal Flow

The smallest product path is:

```text
user sends message to Direxio AI
  -> message-server persists the user message
  -> message-server POSTs an AgentMessageEvent to agent-service
  -> agent-service runs the configured agent runtime
  -> runtime calls ai-gateway for model decisions
  -> optional LangChain runtime executes local read-only tools
  -> runtime calls ai-gateway again for the final answer when tools were used
  -> agent-service returns outbound_message
  -> message-server persists outbound_message as the AI reply
  -> mobile app receives the normal conversation update
```

This keeps the mobile app simple. The AI reply still appears through the normal message pipeline.

## Message-Server Contract

Recommended direct message-server hook:

```http
POST http://agent-service:8797/v1/message-server/new-message
Content-Type: application/json
```

This endpoint accepts a message-server-shaped event and lets `agent-service` run the adapter locally.

Advanced normalized contract:

```http
POST http://agent-service:8797/v1/agent/messages
Content-Type: application/json
```

Required normalized request shape:

```json
{
  "conversation_type": "direxio_ai",
  "node_id": "self-hosted-node-id",
  "conversation_id": "direxio-ai-conversation-id",
  "messages": [
    {
      "sender": "user",
      "content": "Hello"
    }
  ]
}
```

For the direct message-server endpoint, the native shape may use the current product naming:

```json
{
  "conversation_type": "agent",
  "room_id": "!agents:example.com",
  "node_id": "example.com",
  "sender_kind": "user",
  "content": "Hello"
}
```

`product-agent` normalizes this to `conversation_type: "direxio_ai"` before calling `ai-gateway`.

Expected success response:

```json
{
  "reply": "Hello, how can I help?",
  "outbound_message": {
    "conversation_id": "direxio-ai-conversation-id",
    "content": "Hello, how can I help?"
  }
}
```

`message-server` persists `outbound_message.content` as a message from the AI identity in `outbound_message.conversation_id`.

The sample adapter lives at `src/lib/message-server-adapter.ts`. It is imported by product-agent, while real message-server code maps its own Matrix event into the same HTTP request shape.

## Privacy Rule

Do not send other human conversations to `agent-service` by default.

If the user explicitly uses an action such as `Ask AI`, `Forward to AI`, or selected-text assist, `message-server` may include:

```json
{
  "selected_context": "Only the text explicitly selected by the user.",
  "context_authorized": true
}
```

If `context_authorized` is not exactly `true`, `agent-service` ignores `selected_context`.

The first local tools layer follows the same boundary. It can add context from
the current AI thread, explicit thread preferences, contact data already
included in the agent event, and optionally public web search. It does not read
private human chats by default. Any future cross-room or private-message tool
must enforce explicit authorization outside the prompt, preferably in a
deterministic policy layer before the tool runs.

The MCP current-thread search hook keeps the same boundary. Its client receives
only `nodeId`, `conversationId`, `query`, and `limit`, and it is disabled unless
`DIREXIO_AGENT_MCP_CURRENT_THREAD=1` plus a runtime-injected client are both
present. It is a skeleton for wiring the existing MCP surface later, not a
global message reader.

Thread memory is currently process-local and scoped by `conversation_id`. It is
safe for MVP behavior tests, but production long-term memory should be
persistent, user-visible, deletable, and opt-out capable.

## Mobile Contract

Mobile should treat `Direxio AI` as a product-managed conversation entry, not as a normal user account that can be invited, blocked, or called.

Minimum mobile states:

- Available: open the AI conversation and send a normal message.
- Setup needed: show owner-facing setup guidance when the backend returns `setup_needed`.
- Temporarily unavailable: show retry guidance for gateway or provider outages.
- Quota exceeded: show that the AI quota is used up for this node.

## Deployment Contract

The self-hosted server needs these values when hosted AI is enabled:

```env
DIREXIO_AI_TOKEN=dxai_xxx
DIREXIO_AI_GATEWAY_URL=https://ai.direxio.com
DIREXIO_PRODUCT_AGENT_URL=http://product-agent:8797
DIREXIO_AGENT_RUNTIME=local
DIREXIO_AGENT_MAX_MODEL_CALLS=3
DIREXIO_AGENT_GATEWAY_TIMEOUT_MS=30000
```

`DIREXIO_AI_TOKEN` must stay server-side. It must not be sent to the mobile app or written into public logs. `DIREXIO_PRODUCT_AGENT_URL` is also the feature switch: if empty, message-server does not forward agent-room messages.

Set `DIREXIO_AGENT_RUNTIME=langchain` only when the hosted gateway is using an
OpenAI-compatible provider path that supports `tools` and `tool_calls`. The
provider key still belongs only on the hosted `ai-gateway`; the self-hosted
node only receives `DIREXIO_AI_TOKEN`.

`DIREXIO_AGENT_MAX_MODEL_CALLS` limits how many times one LangChain agent turn
may call the hosted gateway. A tool-using turn normally needs two calls: one
for the model to choose the tool, and one for the final answer after local tool
execution. `DIREXIO_AGENT_GATEWAY_TIMEOUT_MS` applies to each gateway call.
For debugging, `DIREXIO_AGENT_RUNTIME_LOG=1` logs tool names, durations, status,
and model-call counts without logging message content.

The hosted Direxio side runs `ai-gateway` separately from user servers. For the
MVP it can use an environment-variable allowlist:

```env
DIREXIO_AI_GATEWAY_TOKENS=dxai_xxx,dxai_yyy
DIREXIO_AI_GATEWAY_MODEL_MODE=openai-compatible
DIREXIO_MODEL_BASE_URL=https://api.deepseek.com/v1
DIREXIO_MODEL_API_KEY=<provider-api-key>
DIREXIO_MODEL_NAME=deepseek-chat
```

Generate gateway tokens from this package:

```bash
cd product-agent
npm run token:generate
```

`DIREXIO_MODEL_API_KEY` never leaves the hosted gateway. Customer deployments
only receive `DIREXIO_AI_TOKEN`, so rotating a customer token does not require
rotating the provider key.

## Implementation Boundary

The bridge should stay narrow: only the built-in agent room is forwarded by default, and gateway-marked replies are ignored to prevent reply loops.
