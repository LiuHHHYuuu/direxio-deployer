# Product Agent Read-Only MCP Design

## Goal

Connect the self-hosted Product Agent to Direxio contact, room, message, and
channel data through the existing MCP implementation. The first version is
read-only, opt-in, and driven only by an explicit request in the current user
turn.

Example supported requests:

- "Show my contacts."
- "Which channels do I have?"
- "Summarize the latest messages with Alice."
- "What are the newest posts in the product channel?"

The Agent must return one concise natural-language answer. MCP JSON and tool
protocol messages remain internal and must not appear as separate App messages.

## Facing Problem

The Product Agent currently has a fake-injectable
`mcp_current_thread_search` interface, but the production runtime does not
connect to a real MCP server. Its existing `list_contacts` tool can only read
contact data if Message Server happens to include contacts in the incoming
Agent event. As a result, the model cannot independently retrieve the user's
accepted contacts, visible rooms, room history, members, channel posts, or post
comments.

The existing `dirextalk-mcp` repository already implements these capabilities.
Reimplementing the same Message Server queries inside Product Agent would
duplicate contracts and would not create a reusable MCP integration.

## Current Evidence

- `dirextalk-mcp` version `0.1.9` is published on npm and provides a stdio MCP
  server using `@modelcontextprotocol/sdk`.
- Its server registers contact, room, message, member, channel-post, comment,
  send-message, and create-comment tools.
- The package calls existing Message Server `/_p2p/query` and
  `/_p2p/command` actions with the node's Agent token.
- The currently deployed `codex1.p2pagent.im/mcp` returns HTTP 404, so Product
  Agent cannot yet connect directly to a Message Server `/mcp` endpoint.
- Current Product Agent and Message Server containers share the internal Docker
  network, so the stdio MCP child can use `http://message-server:8008` without
  exposing a new public port.

## Scope

In scope:

- Product Agent MCP client and lifecycle.
- Product Agent read-only MCP tools.
- Product Agent privacy and memory policy for MCP-derived data.
- Product Agent service environment values in the existing Compose service.
- Product Agent tests, container verification, and documentation.

Out of scope:

- Mobile App changes.
- Message Server behavior or image upgrades.
- Changes to the existing `dirextalk-mcp` repository.
- Sending ordinary messages or creating channel comments.
- Background room scanning, notifications, or proactive MCP reads.
- A new server-side scoped token implementation.

## Alternatives Considered

### 1. Product Agent Starts `dirextalk-mcp` Over Stdio

Selected.

Product Agent uses the official MCP TypeScript client and
`StdioClientTransport` to start the published `dirextalk-mcp` process. The MCP
process calls the existing Message Server P2P actions.

Benefits:

- Reuses the implemented MCP contracts.
- Does not modify or upgrade Message Server.
- Does not expose a new network listener.
- Keeps the integration inside the Product Agent ownership boundary except for
  narrowly scoped Product Agent Compose environment values.

Costs:

- Product Agent owns a child-process lifecycle.
- The container image gains the MCP package and SDK dependencies.

### 2. Add an MCP HTTP Sidecar

Rejected for the first version. A sidecar creates another container, health
check, network endpoint, and deployment lifecycle. The current MCP HTTP daemon
also does not add enough value over stdio for a single local consumer.

### 3. Upgrade Message Server and Use Its Native `/mcp`

Deferred. This is a clean long-term topology, but the deployed Message Server
does not currently expose the route. Upgrading it has a larger blast radius and
crosses the Product Agent ownership boundary.

## Architecture

```text
Direxio App
  -> Message Server Agent room bridge
  -> Product Agent / LangChain runtime
  -> fixed read-only Agent tool
  -> ReadOnlyDirexioMcpClient
  -> MCP SDK StdioClientTransport
  -> dirextalk-mcp child process
  -> Message Server /_p2p/query
  -> Direxio data stores / Matrix history
  -> MCP structured result
  -> model receives the minimum required evidence
  -> one final App reply
```

MCP is server-side only. The App never receives the Agent token, creates an MCP
connection, or sees MCP protocol payloads.

## Components

### Read-Only MCP Client

Add a typed Product Agent client that owns one lazily started MCP stdio session.
It exposes only a compile-time `ReadOnlyMcpToolName` union and does not expose a
generic arbitrary `callTool(name, args)` method to the Agent runtime.

Allowed MCP names:

- `list_contacts`
- `search_rooms`
- `list_messages`
- `list_room_members`
- `list_channel_posts`
- `list_post_comments`

The client must reject every other name before sending an MCP request. It must
never dynamically register all tools returned by MCP `tools/list`.

The client starts on the first authorized tool call, remains available for
later calls, and closes with the Product Agent process. If the child process
fails, the client may rebuild it once for that request. A second failure returns
a typed unavailable result and does not fall back to a model-only answer.

### Environment Mapping

Product Agent keeps Direxio-facing environment names and maps them into the
names expected by the MCP child:

```env
DIREXIO_AGENT_MCP_READ_ONLY=1
DIREXIO_AGENT_MCP_DOMAIN=http://message-server:8008
DIREXIO_AGENT_TOKEN=<server-side-agent-token>
DIREXIO_AGENT_ROOM_ID=<agent-room-id>
DIREXIO_AGENT_MCP_TIMEOUT_MS=8000
```

Child-process mapping:

```text
DIREXIO_AGENT_MCP_DOMAIN -> DIREXTALK_DOMAIN
DIREXIO_AGENT_TOKEN      -> DIREXTALK_AGENT_TOKEN
DIREXIO_AGENT_ROOM_ID    -> DIREXTALK_AGENT_ROOM_ID
```

The Agent token is supplied to the Product Agent container through server-side
Compose environment substitution. It must not be returned by status APIs,
logged, committed, copied into the App, or sent to the hosted AI Gateway.

The feature is fail-closed. If the feature flag, domain, or token is absent,
the MCP tools are not advertised to the model.

### Agent Tool Adapters

Product Agent exposes fixed LangChain tools matching the six read-only
capabilities. The existing `list_contacts` behavior is upgraded to use MCP when
the read-only MCP client is configured. The current-thread MCP skeleton is
adapted to the real client rather than creating a second MCP transport.

Every tool validates and normalizes its input before MCP invocation:

- Limits are positive integers capped at 20.
- Queries are trimmed and length bounded.
- Room and post IDs must be non-empty strings.
- Time filters must remain valid RFC3339 UTC values when supported.
- Unknown object fields are rejected.

Tool results are reduced to the fields needed for the answer. Large raw
payloads, opaque cursors, and unrelated profile fields are not copied into the
model context unless required by the request.

### Explicit Read Policy

The user's latest turn is the authorization event for this MVP. Product Agent
must not call an App-data tool merely because older context mentioned a person,
room, or channel.

Before invocation, a local policy checks that the latest user turn explicitly
requests the matching data category. Examples include contacts/friends, rooms,
groups, channels, messages/chat history, members, posts, or comments. If intent
is ambiguous, the Agent asks a short clarification instead of reading data.

The policy is evaluated locally before the MCP call. Tool descriptions reinforce
the rule for the model, but the model prompt alone is not treated as the privacy
boundary.

No background task, proactive card, memory job, or startup routine may call
these tools.

### Model And Reply Handling

MCP results are tool evidence inside the existing LangChain loop. The model may
summarize or answer from that evidence, but it must not claim that an MCP read
succeeded when the tool returned an error.

The runtime sends exactly one final `reply` / `outbound_message`. Raw MCP JSON,
tool-call JSON, and intermediate acknowledgements are never emitted as App
messages.

## Privacy And Security

### Per-Turn Data Disclosure

The Product Agent uses a hosted model. Therefore, the minimum MCP data needed
to answer an authorized request is sent through the Direxio AI Gateway to the
configured model provider. An explicit user request such as "summarize my chat
with Alice" is treated as consent for that read during that turn.

Enabling the feature at the node level confirms that the operator accepts this
hosted processing path. A future App privacy setting can provide a richer
one-time disclosure and per-scope controls, but mobile changes are not part of
this slice.

### Data Minimization

- Default and maximum limits prevent full-history reads.
- The Agent reads only the requested room or category.
- Message and channel results are truncated before model submission.
- Tool inputs and outputs are not written to ordinary logs.
- Error logs contain tool name, status category, latency, and request ID only.
- Message Server's `MCPBlockedRoomIDs` policy remains authoritative.

### Memory Isolation

MCP results are ephemeral tool evidence. Third-party contact, message, member,
post, and comment facts must not be proposed as automatic canonical memories.

The user's own explicit preference may still be remembered when independently
eligible. For example, "remember that I prefer short summaries, then summarize
my channel" may store the summary preference, but not the channel participants
or content.

The final assistant answer remains in normal recent conversation history, as
the user can already see it in the Agent room. It is not promoted into long-term
canonical memory solely because MCP was used.

### Current Token Limitation

The current Agent token is accepted by Message Server for both query and command
actions. The Product Agent's fixed allowlist prevents the model from selecting
write tools, but it is not a server-side least-privilege credential. A
compromised Product Agent process could still misuse the broader token.

The long-term security upgrade is a Message Server-issued read-only scoped token
restricted to MCP query actions and optional room scopes. That requires a
separate Message Server contract and is deliberately not hidden inside this
Product Agent change.

## Error Handling

Expected failures map to concise user-safe outcomes:

- Feature disabled or missing config: MCP tools are absent from the model tool
  list.
- Authentication rejected: "App data access needs to be reconfigured."
- Room blocked or forbidden: "This conversation is not authorized for Agent
  access."
- MCP timeout or child failure: "App data is temporarily unavailable."
- Empty results: state that no matching contacts, rooms, messages, or posts were
  found.
- Invalid model-proposed arguments: reject locally and let the model correct the
  call once within the existing Agent loop limit.

Errors must not include tokens, full request payloads, private message content,
or child-process environment values.

## Deployment

The Product Agent image adds pinned dependencies for the MCP client and the
published MCP server. The existing `product-agent` Compose service receives
only the MCP-specific environment values required by the child process. No new
port or container is added.

For the current `codex1` deployment, the Agent token and real Agent room ID are
read from existing protected deployment state and written only into the
root-owned remote `.env`. Verification prints booleans and counts, never secret
values, contact names, or message content.

## Testing And Eval

Focused contract tests must cover:

- MCP is not started when disabled or incompletely configured.
- The client starts one stdio session lazily and reuses it.
- All six allowed tools can be invoked through a fake MCP transport.
- `send_message`, `comment_channel_post`, and unknown names are rejected before
  transport invocation.
- Tool limits are capped and schemas reject malformed IDs and timestamps.
- A user request for contacts or channel data allows the matching tool.
- An unrelated user request cannot trigger an App-data read.
- MCP errors produce one safe final reply without model fabrication.
- MCP JSON and intermediate tool messages are not emitted to the App.
- MCP-derived third-party facts are not saved as canonical memory.
- Existing web search, memory, cards, and pending-task tests continue to pass.

Implementation verification commands:

```text
cd product-agent
npm run check
npm test
npm run build
npm run smoke:container
```

The live deployment probe uses a test conversation and checks only status,
result count, and one-reply behavior. It must not print contact names, room
names, messages, posts, comments, or credentials.

## Success Criteria

- From the Agent chat, a user can explicitly ask for their contacts, rooms,
  members, recent messages, channel posts, or post comments.
- Product Agent retrieves the requested data through real MCP stdio calls.
- The App receives one concise final answer and no protocol JSON.
- No write tool is visible or callable through the Product Agent runtime.
- No background App-data reads occur.
- MCP-derived third-party data does not enter canonical long-term memory.
- Existing Agent behavior and Message Server behavior remain unchanged outside
  this opt-in tool path.
