# Automatic Memory Pipeline Design

## Problem

The current product-agent can persist explicit `remember ...` commands, save
memory through the `memory_save` tool/API, retrieve stored items through vector
search, and compact an overflowing thread into summaries. It does not inspect
ordinary conversation turns and decide which stable user facts, preferences,
goals, or corrections should become durable memory.

This causes two visible problems:

- Useful facts such as a user's home city are seen in the current turn but are
  forgotten unless the user explicitly asks the agent to remember them.
- Existing memory records are append-oriented. There is no canonical key for
  replacing an outdated value, resolving a contradiction, or recording why an
  automatic memory was accepted or rejected.

The goal is to add ChatGPT-like automatic memory behavior without reading human
DMs, adding a second chat reply, or allowing the language model to bypass
privacy policy.

## Selected Approach

Use a hybrid pipeline:

1. A model-backed extractor proposes structured memory candidates from the
   latest user message and a small amount of current Agent-thread context.
2. A deterministic policy engine validates value, durability, confidence,
   sensitivity, scope, and supported operation.
3. A reconciler applies accepted `create`, `update`, `delete`, or `noop`
   operations using a stable semantic key.
4. The existing memory store persists accepted records and the existing vector
   index retrieves them on later turns.

Alternatives rejected:

- Letting the main agent call `memory_save` whenever it chooses is the current
  mechanism. It is cheap but inconsistent and mixes response planning with
  memory governance.
- Periodic full-history profile synthesis reduces per-turn work but produces
  stale memory, makes corrections difficult to trace, and is too broad for the
  first production version.

## Scope And Privacy Boundary

Automatic extraction only receives messages already authorized for the
Direxio Agent conversation. It must not read private human DMs, contacts, files,
or MCP data that was not part of the current Agent turn.

The following are eligible for automatic owner-level memory:

- stable profile facts, such as city or occupation;
- durable response, language, content, and workflow preferences;
- ongoing goals and projects likely to affect future assistance;
- explicit corrections to an existing memory;
- repeated low-risk facts whose future value is clear.

The following are rejected unless the user explicitly asks to remember them:

- passwords, API keys, access tokens, recovery codes, and credentials;
- exact addresses and government identifiers;
- health, financial, political, religious, sexual, biometric, or similarly
  sensitive personal information;
- temporary moods, one-off weather questions, transient locations, and model
  inferences not directly supported by the user's words;
- facts about third parties that are not necessary user preferences.

Explicit user requests keep using the existing explicit-memory path. They may
store sensitive information only after the policy marks the operation as
explicit, but credential-like secrets are always rejected.

## Data Model

Extend `AgentMemoryItem` with optional backward-compatible metadata:

```ts
type AgentMemoryScope = "owner" | "conversation";
type AgentMemorySensitivity = "low" | "sensitive" | "secret";

interface AgentMemoryItem {
  // Existing fields remain.
  key?: string;
  scope?: AgentMemoryScope;
  confidence?: number;
  importance?: number;
  sensitivity?: AgentMemorySensitivity;
  evidence?: string;
  lastUsedAt?: string;
  useCount?: number;
  supersededBy?: string;
}
```

`key` identifies one semantic slot, for example
`profile.location.city`, `preference.response.length`, or
`project.direxio.goal`. Owner-scoped records are visible across Agent
conversations for the same `ownerId`. Conversation summaries and temporary
thread facts remain conversation-scoped.

Old JSON records without the new fields remain readable and default to
conversation scope. The file schema stays compatible for this MVP; no destructive
migration is required.

## Candidate Contract

The extractor returns data only, never writes memory directly:

```ts
interface MemoryCandidate {
  operation: "create" | "update" | "delete" | "noop";
  key: string;
  text: string;
  type: "preference" | "fact";
  scope: "owner" | "conversation";
  confidence: number;
  importance: number;
  sensitivity: "low" | "sensitive" | "secret";
  evidence: string;
  reason: string;
}
```

The gateway call uses `task: "memory_extract"`, no tools, a strict system
prompt, and a JSON-only response. Parsing is fail-closed: malformed output,
timeouts, gateway errors, or unsupported fields produce zero candidates and do
not affect the user-visible reply.

## Deterministic Policy

The model can propose but cannot approve its own candidate. The policy engine:

1. rejects missing/invalid keys and text;
2. rejects secret patterns unconditionally;
3. rejects sensitive candidates unless extraction was triggered by an explicit
   remember/correct/forget instruction;
4. requires configurable confidence and importance thresholds for ordinary
   automatic memory;
5. allows only a bounded key namespace and memory type;
6. converts unsupported or ambiguous operations to `noop`;
7. limits candidates and text length per turn.

Defaults:

```env
DIREXIO_AGENT_AUTO_MEMORY=1
DIREXIO_AGENT_AUTO_MEMORY_MIN_CONFIDENCE=0.80
DIREXIO_AGENT_AUTO_MEMORY_MIN_IMPORTANCE=0.55
DIREXIO_AGENT_AUTO_MEMORY_MAX_CANDIDATES=3
DIREXIO_AGENT_AUTO_MEMORY_TIMEOUT_MS=5000
```

Automatic-memory failures are logged as metadata only when runtime logging is
enabled. Message contents, evidence, and candidate text are not logged.

## Reconciliation

Accepted candidates are applied by `(ownerId, scope, key)`:

- `create`: insert when no active canonical item exists.
- `update`: update the canonical item in place when the value changes; preserve
  `createdAt` and refresh `updatedAt`.
- `delete`: soft-delete the matching canonical item.
- `noop`: do nothing.

If `create` targets an existing key, it becomes an update. Identical values do
not rewrite the file. An older contradictory item with the same canonical key
cannot remain active. Existing unkeyed explicit memories continue to work and
are deduplicated by normalized text.

Examples:

```text
"I live in Beijing"  -> profile.location.city = Beijing
"I moved to Shanghai" -> update profile.location.city = Shanghai
"Forget where I live" -> delete profile.location.city
```

## Runtime Flow

For a normal LangChain turn:

1. Store current messages in short-term thread state.
2. Retrieve relevant owner and conversation memories.
3. Run the existing single LangChain response/tool loop.
4. Store the assistant reply.
5. Run automatic candidate extraction from the latest user message, limited
   recent context, current canonical memories, and assistant reply.
6. Apply policy and reconciliation.
7. Return the original single reply/outbound message.

Step 5 is best-effort and must never emit a second App message. In the first
version it is awaited with a short independent timeout so persistence is
deterministic in tests and survives process exit. Its failure cannot turn a
successful chat response into an error.

Direct card turns do not automatically create owner-profile memories. Existing
card-save behavior remains explicit.

## Components

- `memory/memory-candidate.ts`: candidate types, normalization, and JSON parser.
- `memory/memory-extractor.ts`: model-backed extractor interface and gateway
  implementation.
- `memory/memory-policy.ts`: deterministic privacy/value checks.
- `memory/memory-reconciler.ts`: maps accepted candidates to store operations.
- `memory/thread-memory.ts`: extended item metadata and store interface.
- `memory/file-thread-memory.ts`: owner-scope queries and atomic keyed upserts.
- `runtime/langchain-runtime.ts`: invokes the pipeline after one successful
  reply without altering outbound response count.

The extractor, policy, and reconciler use interfaces so tests can inject a fake
extractor without calling a real model.

## User Experience

This backend phase does not add a second chat bubble. The Agent simply uses the
memory naturally on later turns. The API may include an optional
`memory_changes` metadata array for a future lightweight `Remembered ...` toast,
but message-server and Flutter changes are outside this implementation.

Memory list/delete APIs continue working. Owner-scoped items appear in every
Agent conversation owned by the node; conversation summaries appear only in
their source conversation.

## Tests And Eval

Unit cases:

- ordinary low-risk stable fact is accepted;
- temporary weather/location wording is rejected;
- credentials and sensitive data are rejected;
- malformed extractor JSON fails closed;
- duplicate key/value is a no-op;
- changed value updates one canonical item;
- forget/correction soft-deletes or updates the matching key;
- owner memory is retrieved in a different Agent conversation;
- old unkeyed memory JSON remains readable;
- extractor failure still returns exactly one successful Agent reply;
- automatic extraction never creates an outbound message of its own.

Verification commands:

```bash
cd product-agent
npm run check
npm test
npm run smoke:memory-skill
git diff --check
```

No real provider call is required for contract tests. A later deployed-node
eval should verify city recall, preference correction, forget behavior,
sensitive-data rejection, and single-reply behavior through the real gateway.

## Debugging

When automatic memory fails, inspect in this order:

1. `DIREXIO_AGENT_AUTO_MEMORY` and threshold configuration;
2. runtime metadata for extractor timeout/parse/policy status;
3. `$DIREXIO_AGENT_DATA_DIR/memory/items.json` for canonical key and scope;
4. `$DIREXIO_AGENT_DATA_DIR/memory/vectors.json` for refreshed keyed item hash;
5. the memory list endpoint from both the source and a second conversation;
6. message-server logs only to confirm one inbound and one outbound event.

The normal chat response must remain available even when every automatic-memory
step fails.
