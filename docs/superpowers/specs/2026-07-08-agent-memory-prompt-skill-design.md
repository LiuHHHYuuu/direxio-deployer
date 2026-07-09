# Agent Memory and Prompt Skill Design

## Goal

Build two runnable product-agent capabilities:

1. A persistent memory mechanism that survives product-agent restarts.
2. A user-uploaded Prompt Skill mechanism that lets a non-programmer create small custom agent abilities without uploading executable code.

The work should be shipped with loop engineering: every phase has a small user-visible or test-visible feedback loop, a clear rollback boundary, and a concrete eval.

## Current State

The product-agent already has a minimal agent runtime, built-in Direxio tools, card action output, and a tool manifest endpoint. That gives us a useful base for custom abilities.

The current memory implementation is intentionally small:

- `product-agent/src/lib/memory/thread-memory.ts` stores recent messages in process memory.
- It extracts a few response preferences from explicit "remember" style messages.
- It does not persist to disk or database, so restart loses memory.
- It is scoped as thread memory, not long-lived user memory.

The current tool registry is also simple:

- `product-agent/src/lib/tools/registry.ts` only registers built-in read-only Direxio tools.
- `AgentToolManifest` already has fields such as `source`, `skillKind`, `inputSchema`, `triggerExamples`, and `shareable`.
- Those fields are enough to extend toward uploaded Prompt Skills without changing the whole runtime shape.

The current deploy compose file starts `product-agent` behind the `product-agent` profile, but it does not mount a product-agent data volume. A persistent memory or skill store therefore needs an explicit data directory and volume.

The Flutter app already has an Agent plugin settings surface with skill search/install concepts, but the current skill shape is closer to developer skills from a registry. It is not yet the right UX for a normal user typing a title, description, trigger examples, and prompt.

## Product Principle

Memory and skills must feel useful before they feel powerful.

For the first version:

- Memory is explicit by default. The agent saves something only when the user asks it to remember, taps save, or saves a generated card.
- Prompt Skills are prompt-only. They do not execute arbitrary code.
- Uploaded skills are private to the user's self-hosted node.
- Skills should produce concise, readable outputs by default.
- Raw JSON should never be shown as a normal chat message.
- Any future ability to read human chat content must require explicit selected context or an explicit user action.

## Non-Goals

This design does not implement these in the first loop:

- Public skill marketplace.
- Arbitrary JavaScript, Python, shell, WASM, or container skill upload.
- Automatic reading of all user-to-user conversations.
- Automatic sending to other contacts.
- Remote HTTP skills from unknown third-party domains.
- Cross-user shared memory.
- Vector database or embedding retrieval as a required dependency.

These can be added later behind permissions, review, and stronger sandboxing.

## Target Architecture

```text
Direxio App
  -> message-server / plugin bridge
  -> product-agent
       -> persistent memory store
       -> prompt skill store
       -> built-in tools
       -> skill/tool runner
  -> ai-gateway
  -> model provider
```

The first implementation should keep persistent state inside the product-agent service because the product-agent owns the behavior and can run beside each user's self-hosted backend.

Recommended runtime data directory:

```env
DIREXIO_AGENT_DATA_DIR=/var/lib/direxio-product-agent
```

Local dev default:

```text
product-agent/.direxio-product-agent
```

Docker deploy should mount it:

```yaml
product-agent:
  volumes:
    - product-agent-data:/var/lib/direxio-product-agent
```

## Persistent Memory Model

Use a small file-backed store first. A database can come later when query volume or concurrency requires it.

Suggested item shape:

```ts
export interface AgentMemoryItem {
  id: string;
  ownerId: string;
  conversationId?: string;
  type: "preference" | "fact" | "card_memory" | "skill_result";
  text: string;
  tags: string[];
  source: "user_explicit" | "agent_card_save" | "prompt_skill" | "migration";
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}
```

Storage v1 can be a JSON file:

```text
$DIREXIO_AGENT_DATA_DIR/memory/items.json
```

File-backed memory rules:

- Writes are atomic: write temp file, then rename.
- Deleted items are soft-deleted first, so user mistakes can be recovered during early testing.
- Reads filter by `ownerId` and optionally by `conversationId`.
- The agent injects only the most relevant short memories into the model prompt.
- Memory list/delete endpoints are required before broad rollout, because users need control.

## Prompt Skill Model

Prompt Skill is the normal-user version of a skill.

It is a JSON document, but the App should expose it as a form:

```ts
export interface PromptSkillDefinition {
  schema: "direxio.prompt_skill.v1";
  id: string;
  title: string;
  description: string;
  prompt: string;
  triggerExamples: string[];
  outputKind: "text" | "agent_action_result";
  permissions: PromptSkillPermission[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PromptSkillPermission {
  scope: "current_ai_thread" | "thread_memory";
  access: "read" | "write";
}
```

Storage v1:

```text
$DIREXIO_AGENT_DATA_DIR/skills/prompt-skills.json
```

Validation rules:

- `title` is required and short.
- `description` explains when the skill should run.
- `prompt` is required and cannot contain hidden tool permissions.
- `triggerExamples` must have at least one useful phrase.
- `permissions` are allow-listed.
- `outputKind=agent_action_result` must pass the existing structured-card schema.
- Disabled skills remain stored but are not registered as tools.

## Runtime Flow

Incoming agent message:

```text
1. Normalize request and identify owner/conversation.
2. Store recent thread messages in short-term memory.
3. Load persistent memory relevant to owner/conversation.
4. Build tool registry:
   - built-in tools
   - enabled Prompt Skills
   - memory tools
5. Decide whether a deterministic action/skill matches.
6. If no deterministic match, send model prompt through ai-gateway.
7. Capture structured card output if present.
8. Persist assistant reply and any explicit memory write.
9. Return concise chat text plus structured card metadata.
```

Prompt Skill execution:

```text
User message
  -> trigger match or model tool call
  -> build skill prompt from:
       user message
       selected recent thread context
       allowed memory snippets
       skill definition
  -> model call
  -> validate output
  -> return text/card
```

Memory write execution:

```text
User says "remember ..."
  -> memory_save tool
  -> write AgentMemoryItem
  -> return short confirmation
```

Saved card execution:

```text
User taps Save on card
  -> card_memory_save
  -> write AgentMemoryItem(type="card_memory")
  -> card appears in card collection
```

## API Surface

Product-agent should expose these HTTP endpoints for local/service use:

```text
GET    /v1/agent/memory
POST   /v1/agent/memory
DELETE /v1/agent/memory/:id

GET    /v1/agent/skills
POST   /v1/agent/skills/validate
POST   /v1/agent/skills
POST   /v1/agent/skills/sync
PATCH  /v1/agent/skills/:id
DELETE /v1/agent/skills/:id

GET    /v1/agent/tools
POST   /v1/agent/messages
POST   /v1/message-server/new-message
```

The App may not be able to call product-agent directly in every deployment. If direct access is not available, add a narrow message-server or plugin bridge action later:

```text
agent.memory.list
agent.memory.save
agent.memory.delete
agent.prompt_skill.list
agent.prompt_skill.validate
agent.prompt_skill.save
agent.prompt_skill.delete
```

That bridge is an interface contract and should be implemented only when the backend path is ready.
Product-agent now accepts the official Agent plugin config shape at
`POST /v1/agent/skills/sync` and at `/v1/message-server/new-message` through
`agent_config.skills`. The local message-server bridge now forwards the saved
official Agent plugin config; the remaining proof is remote deployment and live
App verification.

## User Experience Plan

Phase 1 UI should be small:

- In the Agent chat, add Save to Memory for useful generated cards.
- In Agent settings, add My Prompt Skills.
- Prompt Skill creation form fields:
  - Name
  - When to use
  - Prompt
  - Example trigger phrases
  - Output type: Text or Card
  - Enabled toggle
- Show a compact validation result before saving.

Phase 2 UI can add:

- Card Collection.
- Skill templates.
- Skill import/export JSON.
- Per-skill usage history.
- Per-skill permission view.

## Loop Engineering Plan

### Loop 0: Spec and Harness

Objective:

- Lock scope, ownership, and evals before coding.

Implementation:

- Add this spec.
- Add a short plan/checklist in `docs/superpowers/plans` when implementation begins.

Eval:

- Self-review for missing boundaries, missing evals, and unsafe skill execution.

Exit criteria:

- Next loop can start without modifying Flutter or deployment.

### Loop 1: Runnable Persistent Memory

Objective:

- Product-agent remembers explicit memory across restart.

Implementation:

- Add file-backed memory store.
- Add `DIREXIO_AGENT_DATA_DIR`.
- Keep existing `InMemoryThreadMemoryStore` for recent message context.
- Add tests that create a store, write memory, recreate the store, and read the same memory.

Eval:

```bash
npm run check
npm test
npm run build
```

Manual smoke:

```text
POST /v1/agent/messages: "remember I like concise Chinese replies"
Restart product-agent
POST /v1/agent/messages: "what do you remember about my reply style?"
Expected: concise answer mentions Chinese/concise preference.
```

### Loop 2: Memory Tools and Memory API

Objective:

- Agent can list/save/delete memory through controlled tools and HTTP endpoints.

Implementation:

- Add `memory_save`, `memory_list`, `memory_delete` tools.
- Add `/v1/agent/memory` endpoints.
- Add permission scope `thread_memory:read/write` only for trusted memory tools.

Eval:

- Contract tests for save/list/delete.
- Runtime test that a user memory command writes exactly one memory item.
- Ensure non-memory chats do not auto-write persistent memory.

### Loop 3: Prompt Skill Store and Validation

Objective:

- Product-agent accepts, validates, stores, lists, enables, disables, and deletes Prompt Skills.

Implementation:

- Add prompt skill schema and validators.
- Add file-backed prompt skill store.
- Add `/v1/agent/skills` endpoints.
- Reject executable code and unknown permissions.

Eval:

- Unit tests for valid skill, missing prompt, unknown permission, oversized prompt, invalid card output kind.
- Restart persistence test.

### Loop 4: Prompt Skill Runner

Objective:

- Uploaded Prompt Skills become callable agent tools.

Implementation:

- Extend `createAgentToolRegistry` to merge built-in tools with enabled prompt skills.
- Add deterministic trigger matching from `triggerExamples`.
- Add model-backed skill runner.
- Validate card outputs through existing structured output path.

Eval:

- Contract test: upload a "daily check-in card" skill, send matching user message, receive structured card.
- Contract test: disabled skill does not appear in `/v1/agent/tools`.
- Contract test: malformed skill output falls back to readable text, not raw JSON.

### Loop 5: Card Collection and Prompt Skill Upload UI

Objective:

- Normal users can save cards and create Prompt Skills inside the app.

Implementation:

- Add Card Collection entry in Agent UI.
- Add Save button for shareable agent cards.
- Add Prompt Skill form in Agent plugin settings or Agent chat action menu.
- Call the agent bridge/API rather than storing skills only in local Flutter state.

Eval:

```bash
flutter analyze <changed files>
flutter test <new and affected tests>
```

Manual smoke:

- Create a Prompt Skill from the App.
- Trigger it in Agent chat.
- Save the returned card.
- Open Card Collection and see it.
- Confirm no raw JSON appears in chat preview or bubble.

### Loop 6: Deployment and Upgrade

Objective:

- Self-hosted node can deploy product-agent memory and skills without manual container hacking.

Implementation:

- Add product-agent data volume to compose.
- Document required env vars.
- Update deployment smoke steps.

Eval:

- Deploy to test node.
- Upload skill.
- Restart product-agent container.
- Verify memory and skill still exist.

## Surface Model

Locked:

- No arbitrary code upload.
- No automatic human chat reading.
- No automatic sending to contacts.
- No raw JSON in chat.
- Prompt Skills must use allow-listed permissions.

Editable:

- Product-agent memory implementation.
- Product-agent prompt skill store and runner.
- Product-agent tool registry.
- Product-agent contract tests.
- Flutter Agent settings and card collection after backend loop passes.

Append-only:

- Spec updates.
- Implementation plan notes.
- Eval logs.
- Rejected design notes.

Human-controlled:

- Message-server bridge changes.
- Production credential changes.
- Public skill marketplace.
- Any permission that reads human chat content beyond selected context.

## Debugging Guide

When memory does not work:

1. Check `DIREXIO_AGENT_DATA_DIR`.
2. Check `$DIREXIO_AGENT_DATA_DIR/memory/items.json`.
3. Check whether the memory was explicit enough to trigger `memory_save`.
4. Check product-agent logs around `/v1/agent/messages` or
   `/v1/message-server/new-message`.
5. Check whether owner/conversation IDs match.

When a Prompt Skill does not run:

1. Check `/v1/agent/skills`.
2. Check `/v1/agent/tools`.
3. Check whether the skill is enabled.
4. Check `triggerExamples`.
5. Check validation errors from `/v1/agent/skills/validate`.
6. Check model response parsing if `outputKind=agent_action_result`.

When the App shows JSON:

1. Check product-agent structured output.
2. Check message payload key `io.direxio.agent_action_result`.
3. Check hidden body flag `io.direxio.agent_hide_body`.
4. Check Flutter `agent_message_content.dart` parser.
5. Check message preview handling.

## Vibecoder Notes

面对的问题:

- Current memory disappears after restart.
- Current skills are developer-oriented and not easy for normal users to create.
- Card outputs are useful, but they need memory and customization to become a repeatable product experience.

做出什么方法尝试:

- Add file-backed persistent memory first.
- Add Prompt Skill upload as data, not executable code.
- Register Prompt Skills as tools only after validation.
- Defer broad Flutter/backend bridge changes until product-agent memory and skill APIs pass contract tests.

依据是什么:

- Product-agent already owns agent behavior and tool registration.
- Existing tool manifest fields already support skill metadata.
- Self-hosted deployment needs local persistence.
- User trust requires explicit memory and permission boundaries.

最后 eval 获得了什么样的结果:

- Product-agent implementation loops must run `npm run check`, `npm test`, and `npm run build`.
- Flutter UI loops must run focused `flutter analyze` and affected widget/unit tests.
- Remote deployment smoke remains a separate human-controlled loop.

vibecoder 必须掌握的内容:

- Persistent memory is separate from recent thread context.
- Prompt Skill is data: title, description, triggers, prompt, permissions, output type.
- The registry is the bridge: built-in tools plus enabled Prompt Skills become agent-callable tools.
- Product-agent can sync Flutter plugin config-shaped Prompt Skills through `agent_config.skills`.
- Local Flutter Card Collection is not yet server memory; it needs a future bridge/API before saved cards sync to product-agent memory.
- If behavior breaks, inspect data file, `/v1/agent/tools`, `/v1/agent/skills`, product-agent logs, then Flutter parser.
