# Product Agent Read-Only MCP Implementation Plan

Spec: `docs/superpowers/specs/2026-07-10-product-agent-readonly-mcp-design.md`

## Objective

Let the self-hosted Product Agent read explicitly requested Direxio contacts,
rooms, messages, members, channel posts, and post comments through the published
`dirextalk-mcp` stdio server, while preventing write-tool exposure, background
reads, raw MCP JSON replies, and canonical memory capture of third-party data.

## Loop Status

| Loop | Status | Deliverable | Eval |
| --- | --- | --- | --- |
| 0 | Done | Approved design and implementation plan | Spec self-review |
| 1 | Done | Typed read-only MCP client and fixed allowlist | Focused client contract tests |
| 2 | Done | Six Product Agent MCP tool adapters and intent policy | Focused tool contract tests |
| 3 | Done | LangChain runtime wiring and one-reply behavior | Agent loop contract tests |
| 4 | Done | MCP-to-memory isolation | Automatic-memory and compression regression tests |
| 5 | Done | Product Agent image/config wiring and docs | Render/config checks |
| 6 | Done | Full local and container verification | Check, test, build, container smoke |
| 7 | Pending | `codex1` deployment and redacted live probe | Counts/status only |

Local loop evidence:

- The published `dirextalk-mcp@0.1.9` process completed a real stdio call to an
  isolated fake Message Server on Windows and inside the production Alpine
  container image.
- Read-only policy tests reject write names before transport, require matching
  latest-turn intent, cap limits, and suppress raw protocol JSON.
- LangChain tests cover contacts, channel resolution followed by post reading,
  one final outbound reply, failure anti-fabrication, and skipped automatic
  memory extraction.
- In-memory and file-backed stores remove existing compressed summaries and
  persist a no-auto-compression marker after MCP App data is used.
- `npm run check`, `npm test`, `npm run build`, `npm run smoke:container`,
  rendered Compose checks, `docker compose config --quiet`, and
  `git diff --check` pass.

## Loop 1: MCP Client

Files:

- Add `product-agent/src/lib/mcp/read-only-direxio-mcp-client.ts`.
- Update `product-agent/package.json` and lockfile with pinned compatible MCP
  client and `dirextalk-mcp` dependencies.
- Extend `tests/product_agent_contract_test.ts` with client tests.

Steps:

1. Define the six-name `ReadOnlyMcpToolName` union.
2. Define a narrow client interface with typed `call`, `configured`, and
   `close` behavior.
3. Add a lazy stdio transport factory so tests can inject a fake transport.
4. Map Product Agent environment names to the child `DIREXTALK_*` names.
5. Reject disabled/incomplete configuration before process startup.
6. Reject write and unknown names before transport invocation.
7. Reuse one initialized client and allow one rebuild after transport failure.
8. Cap each call with `DIREXIO_AGENT_MCP_TIMEOUT_MS`.

Eval:

- Disabled and incomplete config do not start the transport.
- All six allowed names reach the fake client.
- `send_message`, `comment_channel_post`, and unknown names never reach it.
- Secret values do not appear in errors.

## Loop 2: Tool Adapters And Intent Policy

Files:

- Add `product-agent/src/lib/tools/mcp-read-tools.ts`.
- Add `product-agent/src/lib/tools/mcp-read-policy.ts`.
- Update `product-agent/src/lib/tools/direxio-tools.ts`.
- Update `product-agent/src/lib/tools/registry.ts` and tool permission types.
- Adapt the existing current-thread MCP tool to the real read-only client.
- Extend contract tests.

Steps:

1. Expose only the six approved tool schemas to LangChain.
2. Upgrade existing `list_contacts` to MCP when configured without creating a
   duplicate model tool name.
3. Validate IDs, query lengths, RFC3339 UTC timestamps, cursors, and limits.
4. Cap returned collections and message text before model submission.
5. Require latest-turn explicit intent for the matching scope.
6. Return a safe clarification/denial result when intent is absent.
7. Preserve Message Server forbidden/blocked-room errors as safe categories.

Eval:

- Explicit Chinese and English requests authorize only the matching category.
- Older-turn mentions do not authorize a current read.
- Malformed input is rejected locally.
- Tool output is concise text, not an App outbound JSON object.

## Loop 3: Runtime Wiring

Files:

- Update `product-agent/src/lib/runtime/index.ts`.
- Update `product-agent/src/lib/runtime/langchain-runtime.ts`.
- Update Agent service lifecycle construction if needed for client close.
- Extend contract tests.

Steps:

1. Create the MCP client from runtime environment only when fully configured.
2. Register fixed read-only tools; never dynamically import MCP `tools/list`.
3. Let normal LangChain tool calling select an authorized read tool.
4. Feed reduced MCP evidence back to the model.
5. Return exactly one final `reply` and matching `outbound_message.content`.
6. On MCP failure, suppress model fabrication and return one concise safe reply.

Eval:

- Contacts and channel flows perform MCP call -> model synthesis -> one reply.
- Raw JSON and tool-call envelopes are absent from outbound messages.
- Existing pending task, web search, cards, and model-call-limit tests pass.

## Loop 4: Memory Isolation

Files:

- Update automatic-memory orchestration or candidate policy in Product Agent.
- Extend memory contract tests.

Steps:

1. Mark turns that used MCP App-data tools.
2. Prevent third-party MCP facts from becoming automatic canonical memories.
3. Keep independently explicit first-party preferences eligible.
4. Keep final assistant text only in normal recent conversation history.

Eval:

- Contact names, room members, private messages, posts, and comments are absent
  from canonical memory after MCP-backed turns.
- An explicit user preference in the same turn remains eligible.

## Loop 5: Image And Configuration

Files:

- Update `product-agent/Dockerfile` only as required by installed npm packages.
- Update the `product-agent` section of
  `scripts/cloud-init/docker-compose.yml` with MCP feature environment values.
- Update `product-agent/README.md` and `product-agent/INTEGRATION.md`.
- Update focused render/config tests.

Steps:

1. Keep MCP disabled by default.
2. Pass only domain, Agent token, Agent room ID, and timeout to Product Agent.
3. Do not mount the full bootstrap credential file into Product Agent.
4. Add no public port and no new service.
5. Document hosted-model disclosure and the current broad-token limitation.

Eval:

- Rendered Compose includes only Product Agent-owned MCP values.
- Secret values are substitutions, never literals.
- Existing default-off Product Agent profile behavior remains unchanged.

## Loop 6: Full Local Verification

Commands:

```text
cd product-agent
npm run check
npm test
npm run build
npm run smoke:container
```

Also run:

```text
git diff --check
bash tests/render_userdata_remote_nodes_test.sh
```

Review the final diff for ownership-boundary violations and secret leakage.

## Loop 7: Deployment

1. Build a versioned Product Agent image from the verified commit.
2. Configure the existing protected remote `.env` without printing values.
3. Restart only `product-agent`.
4. Verify Message Server remains healthy.
5. Run redacted live probes for contacts and rooms.
6. Assert only status, counts, selected tool names, and one-reply behavior.
7. Do not print names, room IDs, messages, posts, comments, or credentials.
8. Preserve the previous image and `.env` backup for rollback.

## Completion Gates

- All local evals pass on the shipped commit.
- No write MCP tool is registered or callable.
- No App-data read occurs without latest-turn explicit intent.
- MCP-derived third-party data is absent from canonical memory.
- App receives one final reply without raw protocol JSON.
- Remote Product Agent is running the versioned image.
- Remote Message Server remains healthy.
- Redacted live MCP probe passes without exposing private content.
