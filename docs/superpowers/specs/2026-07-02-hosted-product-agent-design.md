# Hosted Product Agent Design

## Goal

Add a product-facing Direxio AI friend that appears in the mobile app like a normal contact. The first version should let users chat with `Direxio AI`, ask for reply help, translation, rewriting, summaries, and general conversation without requiring the user's computer, Codex, Claude, Hermes, or `direxio-connect` to stay online.

## Scope

This design adds a new product agent path. It does not replace the existing deployer/runtime bridge:

- Existing `cc-connect` and `direxio-connect` remain for developer and operator workflows.
- Existing MCP artifacts remain available for tool-capable runtimes.
- The first product agent does not auto-read all user chats.
- The first product agent does not run a local model by default.
- The first product agent does not send messages to other contacts on the user's behalf.

## Product Contract

The mobile app shows `Direxio AI` as a special contact or conversation entry. It occupies the same list surface as a normal friend so the first version feels familiar and does not require a new primary app tab.

When the user opens this conversation, they can:

- Chat normally with the AI friend.
- Paste or forward selected text for translation, rewriting, summarization, or tone analysis.
- Ask the AI to draft a reply.

When the AI produces a reply for another human conversation, the app treats it as a draft. The user must choose whether to copy or send it. Automatic sending is out of scope for the first version.

Future versions may add an independent Agent tab for task history, memory, permissions, and richer tool workflows.

## Architecture

The MVP uses two new services:

```text
Direxio mobile app
  -> user self-hosted message-server
  -> user self-hosted agent-service
  -> Direxio hosted ai-gateway
  -> model provider
```

`agent-service` runs beside the user's self-hosted Direxio backend, preferably as another Docker service in the same deployment as `message-server`, `postgres`, `caddy`, and `coturn`.

`ai-gateway` is operated by Direxio. It owns the real model provider API keys and exposes a Direxio-controlled API to deployed nodes.

The user's deployed server stores only a Direxio-issued AI token:

```env
DIREXIO_AI_ENABLED=true
DIREXIO_AI_MODE=hosted
DIREXIO_AI_GATEWAY_URL=https://ai.direxio.com
DIREXIO_AI_TOKEN=dxai_xxx
```

The user's server must not receive or store Direxio's OpenAI, Claude, Gemini, or other provider keys.

## Service Responsibilities

`agent-service` owns product-agent behavior inside the self-hosted node:

- Detect messages sent to the `Direxio AI` conversation.
- Build the prompt and short conversation context for the AI friend.
- Enforce local privacy policy before adding any external conversation content.
- Call `ai-gateway` with `DIREXIO_AI_TOKEN`.
- Stream or post the generated reply back into the `Direxio AI` conversation.
- Keep model-provider details hidden from the app client.

`ai-gateway` owns hosted AI access:

- Validate `DIREXIO_AI_TOKEN`.
- Map the node or account to a plan, quota, and rate limit.
- Select the configured model provider and model.
- Call the provider using Direxio-owned credentials.
- Return text responses, and later streamed chunks, to `agent-service`.
- Record usage metadata for billing and abuse prevention.
- Avoid storing raw chat content by default unless a later explicit diagnostics mode requires it.

## Data Flow

For ordinary AI chat:

1. User sends a message to `Direxio AI` in the app.
2. `message-server` persists the message.
3. `agent-service` observes or receives the new AI conversation message.
4. `agent-service` sends the minimum necessary context to `ai-gateway`.
5. `ai-gateway` calls the model provider.
6. `agent-service` writes the AI reply into the same conversation.
7. The app displays the reply like a normal incoming message.

For chat-assist tasks:

1. User explicitly selects, forwards, or pastes content into the AI conversation.
2. `agent-service` treats that selected content as user-provided context.
3. The model generates translation, summary, tone analysis, or a draft reply.
4. The app presents generated output in the AI conversation or as a draft action.

The MVP must not scan unrelated rooms in the background.

## Privacy And Permissions

Default privacy rule: `Direxio AI` only sees messages in its own AI conversation and content the user explicitly sends to it.

Allowed first-version context sources:

- User messages sent directly to `Direxio AI`.
- Text pasted into the AI conversation.
- Messages explicitly forwarded or selected with an action such as `Ask AI`.

Not allowed in the first version:

- Background reading of all rooms.
- Automatic reading of a human conversation without a user action.
- Long-term AI memory across conversations.
- Provider-side training assumptions in product copy.
- Auto-sending a message to another user.

Hosted AI mode must display a clear disclosure:

```text
Hosted AI sends the content you provide to Direxio AI service to generate replies.
```

## MCP Relationship

Existing `direxio-mcp` remains a tool surface for agent runtimes and can also inform later product-agent tooling. For the MVP product agent, MCP should not be exposed to the mobile app.

If `agent-service` uses MCP internally later, it should do so through a server-side tool adapter with explicit policy checks. The app client should never hold MCP credentials or call MCP directly.

The existing split remains important:

- `cc-connect`: developer/operator bridge from Matrix to local agent runtimes.
- `direxio-mcp`: tool interface for reading/searching/sending Direxio data.
- `agent-service`: product-facing AI friend runtime.
- `ai-gateway`: Direxio-hosted model access and quota gateway.

## Deployment

The first deployment path should add `agent-service` to the self-hosted node's Docker composition. It should be enabled only when hosted AI config is present.

Suggested service-level behavior:

- If `DIREXIO_AI_ENABLED` is false or missing, `agent-service` stays disabled or returns a setup-needed state.
- If `DIREXIO_AI_TOKEN` is missing, the app can show `Direxio AI` as unavailable with setup guidance.
- If `ai-gateway` is unreachable, `agent-service` reports a temporary unavailable message instead of dropping user messages.

The deployer can later write these environment values into generated `.env` or service state, but the MVP implementation should keep AI secrets out of logs, reports, chat messages, and app clients.

## API Sketch

`agent-service` calls the hosted gateway:

```http
POST https://ai.direxio.com/v1/chat
Authorization: Bearer <DIREXIO_AI_TOKEN>
Content-Type: application/json
```

Example request:

```json
{
  "node_id": "node-or-service-id",
  "conversation_id": "direxio-ai-room-id",
  "messages": [
    {
      "role": "user",
      "content": "Please make this sentence softer: I think you are wrong."
    }
  ],
  "task": "chat",
  "model": "default"
}
```

Example response:

```json
{
  "reply": "I understand your point, though I see it a little differently."
}
```

Streaming can be added after the non-streaming path works.

## Error Handling

`agent-service` should return user-friendly messages for expected failures:

- Missing AI token: tell the user AI is not enabled for this node.
- Gateway authentication failure: tell the owner to refresh or reissue the AI token.
- Quota exceeded: tell the user the AI quota is used up.
- Provider timeout: tell the user to retry later.
- Unsafe or unsupported request: decline briefly and offer a safer alternative.

Operational logs should include request ids, status, latency, token usage, and error categories. Logs must not include full prompts, provider keys, AI tokens, Matrix access tokens, or user private message content by default.

## Testing

Initial implementation should include focused checks for:

- `agent-service` ignores non-AI conversations.
- `agent-service` replies to the `Direxio AI` conversation when hosted AI succeeds.
- Missing `DIREXIO_AI_TOKEN` produces a setup-needed response.
- Gateway 401, 429, and 5xx responses produce safe user-facing messages.
- The mobile client never receives provider API keys or `DIREXIO_AI_TOKEN`.
- AI requests include only the AI conversation content unless the user explicitly forwards or selects extra context.

Integration tests can use a fake `ai-gateway` that returns deterministic replies and records whether forbidden context was sent.

## Open Decisions

- How `Direxio AI` is provisioned as a contact or room in `message-server`.
- Whether `agent-service` observes messages through Matrix sync, a message-server event hook, or an internal queue.
- How Direxio issues and rotates `DIREXIO_AI_TOKEN` for self-hosted nodes.
- Whether the first mobile UI exposes `Ask AI` from another conversation or only supports paste/forward into the AI chat.
- Which model provider and default model the hosted gateway uses first.

These decisions are implementation-level choices and should be resolved before coding the MVP.
