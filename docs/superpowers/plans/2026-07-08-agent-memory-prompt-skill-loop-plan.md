# Agent Memory and Prompt Skill Loop Plan

Spec: `docs/superpowers/specs/2026-07-08-agent-memory-prompt-skill-design.md`

Operator runbook: `docs/superpowers/plans/2026-07-08-agent-memory-prompt-skill-operator-runbook.md`

Live App checklist: `docs/superpowers/plans/2026-07-08-agent-memory-prompt-skill-live-app-checklist.md`

## Objective

Ship a runnable product-agent memory mechanism and user-uploaded Prompt Skill mechanism through small verified loops.

## Loop Status

| Loop | Status | Deliverable | Eval |
| --- | --- | --- | --- |
| 0 | Done | Spec and executable phase plan | Scope/self-review |
| 1 | Done | File-backed persistent memory | `npm run check`, `npm test`, `npm run build` |
| 2 | Done | Memory tools and memory HTTP API | `npm run check`, `npm test`, `npm run build` |
| 3 | Done | Prompt Skill schema, validation, store | `npm run check`, `npm test`, `npm run build` |
| 4 | Done | Prompt Skill runner registered as tools | `npm run check`, `npm test`, `npm run build` |
| 5 | Partial | Flutter card collection and Prompt Skill upload UI | Local UI tests and card-to-memory sync done; deployed App bridge pending |
| 6 | Done | Deploy volume and product-agent node smoke | Local smoke, container smoke, remote product-agent smoke |
| 7 | Partial | message-server agent-room bridge to product-agent | Focused Go tests and build done; remote message-server restart pending |
| 8 | Done | message-server Agent memory bridge actions | Focused Go tests, build, and verifier coverage updated |

## Completion Audit

Current objective: ship a runnable Agent memory mechanism and user-uploaded
Prompt Skill mechanism with staged loop engineering evidence.

| Requirement | Current evidence | Completion state |
| --- | --- | --- |
| Persistent explicit memory survives product-agent restart | Product-agent contract tests, build, local memory/Prompt Skill smoke, container smoke, and earlier remote product-agent smoke passed. `DIREXIO_AGENT_DATA_DIR` and `product-agent-data` are wired in deploy config. | Locally proven; latest remote product-agent image still needs redeploy after new smoke changes. |
| Prompt Skills can be created by normal users without code upload | Flutter Agent plugin UI test saves a `direxio.prompt_skill.v1` entry into plugin config; product-agent validates, stores, lists, deletes, and registers Prompt Skills as tools. | Locally proven; live App account flow pending. |
| Freshly uploaded Prompt Skill can reach product-agent through message-server config | Product-agent contract test and strengthened smoke cover `/v1/message-server/new-message` with a skill that exists only in `agent_config.skills`. | Locally proven; remote product-agent currently reports `config-only-smoke=missing`, so latest image is not deployed. |
| Real agent-room messages are bridged from message-server to product-agent | Focused Go tests cover `DIREXIO_PRODUCT_AGENT_URL`, owner agent-room forwarding, `agent_config.skills`, non-blocking dispatch, gateway loop prevention, and card payload conversion. Message-server Apply now health-checks after restart and verifies the deployed binary contains product-agent bridge markers plus a configured `DIREXIO_PRODUCT_AGENT_URL`. | Locally proven; remote message-server restart/deploy pending. |
| App-callable memory bridge actions exist | Message-server official Agent plugin allowlist includes `agent.memory.list`, `agent.memory.save`, and `agent.memory.delete`. `plugins.invoke` routes these actions to product-agent `GET/POST/DELETE /v1/agent/memory` when `DIREXIO_PRODUCT_AGENT_URL` is configured. Focused Go tests cover save/list/delete routing, missing bridge behavior, and HTTP product-agent memory endpoints. Flutter Card Collection now best-effort syncs saved cards through `plugins.invoke` -> `agent.memory.save`, while keeping local save authoritative if sync fails. | Locally proven; live deployed App verification pending. |
| Card/capsule replies do not expose raw JSON in the App | Product-agent promotes final action-result JSON to structured outbound content; message-server maps it to Matrix `io.direxio.agent_action_result` plus hide-body marker; Flutter parser/body tests cover card rendering and fallback hiding. | Locally proven; live App visual verification pending. |
| Loop engineering harness is repeatable | `scripts/verify-agent-memory-skill-loop.ps1` passes product-agent check/test/build/smoke, message-server bridge tests/build, Flutter Agent card / Prompt Skill UI tests, PowerShell parser checks, and completion-audit evidence self-tests. Deploy scripts are dry-run guarded, run the verifier by default before Apply, and product-agent Apply now requires post-deploy config-only smoke readiness. | Ready for approved deployment loop. |

## Goal Completion Gates

Do not mark the Agent memory + Prompt Skill objective complete until every gate
below has current evidence from the same branch/build that is being shipped.

| Gate | Required evidence | Current state |
| --- | --- | --- |
| Local product-agent correctness | `scripts\verify-agent-memory-skill-loop.ps1` passes product-agent typecheck, contract tests, build, and memory/Prompt Skill smoke. | Passed in the latest local verifier run. |
| Local message-server bridge correctness | The same verifier passes focused Go bridge tests and `go build ./cmd/dirextalk-message-server`; `agent.memory.*`, card payload conversion, and `agent_config.skills` forwarding are covered. | Passed in the latest local verifier run. |
| Local Flutter user path correctness | The same verifier passes Agent card parsing/body tests, Prompt Skill create/edit UI tests, Card Collection store tests, and Card Collection provider sync tests. | Passed in the latest local verifier run. |
| Remote product-agent is the latest deployable build | `inspect-agent-stack-readiness.ps1 -RequireConfigOnlySmoke` passes and prints `config-only-smoke=present`. | Failing on current remote: `config-only-smoke=missing`. |
| Remote message-server has the latest bridge build | `inspect-agent-stack-readiness.ps1 -RequireLatestMessageServerBridge` passes and prints `agent-card-bridge=present`, `agent-memory-plugin-bridge=present`, and `product-agent-url-env=present`. | Failing on current remote: `agent-card-bridge=missing`, `agent-memory-plugin-bridge=missing`. |
| Full deployed stack gate | `deploy-agent-memory-skill-stack.ps1 -Apply -IUnderstandThisRestartsProductAgent -IUnderstandThisRestartsMessageServer` completes, then combined readiness with `-RequireConfigOnlySmoke -RequireLatestMessageServerBridge` passes. | Pending explicit human restart approval. |
| Live App Prompt Skill path | Complete the Prompt Skill section in `2026-07-08-agent-memory-prompt-skill-live-app-checklist.md`: create/edit one Prompt Skill in the deployed App, send an Agent chat message that should trigger it, and confirm product-agent receives the skill through `agent_config.skills`. | Pending deployed App verification. |
| Live App memory path | Complete the Memory section in `2026-07-08-agent-memory-prompt-skill-live-app-checklist.md`: save one structured Agent card, confirm local Card Collection persists it, and confirm `plugins.invoke -> agent.memory.save` succeeds through message-server/product-agent. | Pending deployed App verification. |
| Live App card rendering path | Complete the Card Rendering section in `2026-07-08-agent-memory-prompt-skill-live-app-checklist.md`: confirm the visible Agent reply renders as a card/capsule and does not show raw `direxio.agent_action_result.v1` JSON. | Pending deployed App verification. |

Completion audit command:

- Use `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\audit-agent-memory-skill-goal.ps1 -NodeDomain codex1.p2pagent.im` to run the local verifier, strong remote readiness, and live-App manual gate audit.
- Use `-ReportOnly` when the goal is expected to be incomplete and the command should print the blocking gates without failing the shell.
- Use `-SummaryJsonPath <path>` when the audit result should be saved as machine-readable evidence; the JSON uses schema `direxio.agent_memory_prompt_skill_audit.v1`.
- Use `-LiveAppPromptSkillVerified -LiveAppMemoryVerified -LiveAppCardRenderingVerified` only after the matching sections in `2026-07-08-agent-memory-prompt-skill-live-app-checklist.md` have actually been completed by the operator.
- When any live App verified flag is supplied, also pass `-LiveAppEvidencePath <filled evidence file>`; otherwise the matching live gates fail instead of passing on flags alone. The evidence file must contain non-placeholder required field values plus exact `- Result: PASS` lines for the Prompt Skill, Memory, and Card Rendering sections.

Latest core path audit:

- Scope: reviewed the App card-save memory sync, official Agent plugin memory bridge, product-agent memory API/store, Prompt Skill upload UI, message-server `agent_config.skills` forwarding, and product-agent Prompt Skill config sync.
- Result: field shapes are aligned across the three repos. Flutter saves cards locally first, then best-effort invokes `agent.memory.save` with `conversation_id`, `text`, `type=card_memory`, `source=agent_card_save`, and `tags`; message-server validates and proxies that shape; product-agent accepts and persists the same type/source values.
- Prompt Skill path: Flutter writes `direxio.prompt_skill.v1` entries into official Agent plugin `skills` config; message-server forwards that config as `agent_config.skills`; product-agent syncs prompt skills from the event before building the model payload, so a skill can trigger without a direct preupload call.
- Focused checks passed:
  - `flutter test test\agent_card_collection_provider_test.dart test\plugin_management_page_test.dart --reporter compact`
  - `npm test`
  - `& 'C:\Program Files\Go\bin\go.exe' test ./p2p -run "Test(PluginInvokeAgentMemory|HTTPProductAgentClient|ProjectAgentRoomMessageForwardsToProductAgentWithPluginSkillsAndSendsReply)" -count=1`
- Boundary: no production deploy, remote upload, `.env` edit, or service restart was performed.

Latest completion audit:

- Command: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\preflight-agent-memory-skill-deploy.ps1 -NodeDomain codex1.p2pagent.im`.
- JSON evidence: `docs/superpowers/plans/evidence/20260708-170701-agent-memory-skill-preflight-audit.json`.
- Local verifier: `PASS`. Completion-audit evidence self-tests, product-agent typecheck/tests/build/smoke, message-server bridge tests/build, and Flutter Agent card / Prompt Skill UI tests passed.
- Remote readiness: `FAIL`. The node still reports `agent-card-bridge=missing`, `agent-memory-plugin-bridge=missing`, and `config-only-smoke=missing`.
- Live App gates: `PENDING` for Prompt Skill path, memory path, and card rendering path.
- Boundary: no deploy, upload, `.env` edit, `docker compose up`, or restart was performed.

Latest read-only remote audit:

- Command: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\inspect-agent-stack-readiness.ps1 -NodeDomain codex1.p2pagent.im -RequireLatestMessageServerBridge -RequireConfigOnlySmoke` through the completion audit above.
- Result: `message-server` is healthy, `product-agent` is running, `/v1/agent/actions` and `/v1/agent/tools` respond, `memory_save=true`, and `has_prompt_tools=true`.
- Message-server deployed binary markers: `product-agent-message-bridge=present`, `agent-card-bridge=missing`, `agent-memory-plugin-bridge=missing`, and `product-agent-url-env=present`.
- Product-agent deployed runner marker: `config-only-smoke=missing`, proving the deployed product-agent image does not yet contain the latest config-only Prompt Skill smoke path.
- Strong readiness gate: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\inspect-agent-stack-readiness.ps1 -NodeDomain codex1.p2pagent.im -RequireLatestMessageServerBridge -RequireConfigOnlySmoke` fails on the current remote, as expected, because the latest product-agent and message-server builds have not been deployed.
- Boundary: no deploy, upload, `.env` edit, `docker compose up`, or restart was performed.

Latest guarded deploy preflight:

- Command: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\preflight-agent-memory-skill-deploy.ps1 -NodeDomain codex1.p2pagent.im`.
- Result: `PASS`. The preflight required the local verifier to pass, recorded the expected remote/live blocking gates, and verified the full-stack deploy orchestrator dry-run path.
- Boundary: dry-run mode performed no image build, upload, `.env` edit, container restart, remote smoke, or combined post-deploy readiness.

## Loop 1 Checklist

- Add `DIREXIO_AGENT_DATA_DIR` config.
- Add file-backed memory item store.
- Keep recent conversation context separate from persistent memory.
- Persist explicit "remember" messages.
- Add restart persistence tests.
- Run `npm run check`.
- Run `npm test`.
- Run `npm run build`.

Loop 1 result:

- Added `DIREXIO_AGENT_DATA_DIR`.
- Added file-backed explicit memory at `$DIREXIO_AGENT_DATA_DIR/memory/items.json`.
- Kept recent messages process-local.
- Added restart persistence coverage for preferences and fact memory.
- Verified with product-agent check, test, and build.

## Loop 2 Checklist

- Add `memory_save`, `memory_list`, and `memory_delete` tools.
- Add `/v1/agent/memory` endpoints.
- Make non-explicit chats read memory but not write persistent memory.
- Add contract tests for save/list/delete.

Loop 2 result:

- Added `memory_list`, `memory_save`, and `memory_delete` tools.
- Added `GET/POST/DELETE /v1/agent/memory`.
- Shared one memory store between HTTP endpoints and the agent runtime.
- Added contract coverage for API save/list/delete.
- Added LangChain coverage that a model `memory_save` tool call writes readable memory.
- Verified with product-agent check, test, and build.

## Loop 3 Checklist

- Add Prompt Skill definition type.
- Add validator for title, description, prompt, triggers, output type, and permissions.
- Add file-backed prompt skill store.
- Add `/v1/agent/skills` endpoints.
- Add restart persistence tests.

Loop 3 result:

- Added `direxio.prompt_skill.v1` definition and validation.
- Added in-memory and file-backed Prompt Skill stores.
- Added `GET/POST/DELETE /v1/agent/skills` and `POST /v1/agent/skills/validate`.
- Added `PATCH /v1/agent/skills/:id` so uploaded Prompt Skills can be edited, disabled, and re-enabled without changing their id or bypassing validation.
- Stored Prompt Skills at `$DIREXIO_AGENT_DATA_DIR/skills/prompt-skills.json`.
- Added restart persistence coverage for uploaded Prompt Skills.
- Verified with product-agent check, test, and build.

## Loop 4 Checklist

- Register enabled Prompt Skills in `createAgentToolRegistry`.
- Add deterministic trigger matching.
- Add model-backed Prompt Skill runner.
- Validate structured card output.
- Ensure bad JSON never appears as chat text.

Loop 4 result:

- Registered enabled Prompt Skills in `createAgentToolRegistry`.
- Added `prompt_skill_<id>` manifests with `source: user` and `skillKind: prompt`.
- Refreshed tool registry on each runtime turn so newly uploaded skills work without restart.
- Added trigger matching from `triggerExamples`.
- Injected the Prompt Skill prompt as local tool context for the model.
- Promoted final model replies that are valid `direxio.agent_action_result.v1` JSON into structured `outboundContent` in both local and LangChain runtimes, so user Prompt Skills can produce cards without leaving raw JSON as the agent reply summary.
- Added contract coverage for upload -> tools manifest -> trigger -> gateway prompt.
- Added contract coverage that structured final model replies become short summaries plus structured outbound content through both the LangChain runtime and `/v1/message-server/new-message`.
- Verified with product-agent check, test, and build.

## Loop 5 Checklist

- Add Card Collection UI.
- Add Save to Memory for shareable cards.
- Add Prompt Skill form.
- Connect UI to product-agent API or approved bridge.
- Add parser/preview tests to prevent raw JSON regressions.

Loop 5 progress:

- Added a Prompt Skill creation form in the official Agent plugin config page.
- Prompt Skill entries are stored in the existing plugin `skills` config with `schema: direxio.prompt_skill.v1`.
- The UI path uses existing `plugins.config.update` through `installOrUpdateAgent`; it does not add a new client URL contract.
- Added widget coverage that saving the form writes a prompt skill into Agent plugin config.
- Added widget coverage that selecting the Card output mode writes `output_kind: agent_action_result`, so user-authored Prompt Skills can request structured card output instead of plain text.
- Added Prompt Skill editing from the Agent plugin settings list. The edit flow reuses the Prompt Skill form, preserves the existing skill id and enabled state, and can change a text Prompt Skill into a card-output Prompt Skill.
- Added a local Flutter Card Collection store, provider, collection page, Agent settings entry, and save button on structured Agent cards.
- Card Collection persists locally in `agent_card_collection.json` and now best-effort syncs saved cards through the existing `plugins.invoke` envelope with `action = agent.memory.save`; local save still succeeds if the product-agent bridge is unavailable.
- Added product-agent Prompt Skill sync from official Agent plugin config shapes via `POST /v1/agent/skills/sync` and `/v1/message-server/new-message` `agent_config.skills`.
- Added contract coverage that a Prompt Skill included in a message-server event triggers without preuploading through `/v1/agent/skills`.
- Verified product-agent check, test, build, focused Flutter analyze, Agent settings tests, Agent message body tests, and Card Collection store tests.
- Re-verified Flutter card parsing/body hiding, visual card rendering, Prompt Skill upload UI, and Card Collection store tests after structured final-reply promotion.
- Re-verified the Prompt Skill UI with `flutter test test\plugin_management_page_test.dart`; it now covers both text Prompt Skill upload and Card Prompt Skill upload.
- Re-verified the Prompt Skill management UI with `flutter test test\plugin_management_page_test.dart`; it now covers Prompt Skill creation, Card output creation, and editing an existing Prompt Skill without changing its id or disabled state.
- Real message-server deployment wiring moved into the `dirextalk-message-server` repo as an optional `DIREXIO_PRODUCT_AGENT_URL` bridge; deployed App verification is still pending.

## Loop 6 Checklist

- Add `product-agent-data` volume.
- Document deploy env vars.
- Deploy to test node.
- Upload a skill.
- Save a memory.
- Restart product-agent.
- Verify both persisted.

Loop 6 progress:

- Added `product-agent-data` Docker volume.
- Set `DIREXIO_AGENT_DATA_DIR=/var/lib/direxio-product-agent` in the product-agent service.
- Mounted the volume into product-agent.
- Updated README deployment notes.
- Added render-userdata assertions for the data volume and data dir.
- Added `src/bin/remote-smoke-runner.ts`, a compiled runner for memory/Prompt Skill deploy smoke phases.
- Updated `npm run smoke:memory-skill` to reuse the same remote smoke runner against a local fake gateway, so endpoint contract drift is caught before deployment.
- Added `npm run smoke:container`, which builds the product-agent image, starts temporary fake gateway and product-agent containers, writes memory, syncs a Prompt Skill, restarts the product-agent container, verifies persisted state, then removes temporary Docker resources.
- Added `product-agent/scripts/remote-smoke.sh` for deployed nodes. It runs from `/opt/p2p`, calls the compiled runner inside the product-agent container, optionally restarts only `product-agent`, verifies persistence, and sends one real `/v1/message-server/new-message` event through the configured AI gateway.
- Verified product-agent check, test, build, local memory/skill smoke, Docker container smoke, remote-smoke shell syntax, remote deployed-node smoke on `codex1.p2pagent.im`, and `git diff --check`.
- Verified focused Flutter Agent/Card/Prompt Skill tests and Flutter `git diff --check`.
- Local Docker image build and container smoke now pass after starting Docker Desktop's Linux engine.
- Remote product-agent smoke passed on `codex1.p2pagent.im` after updating the deployed compose file with `product-agent-data`, loading the locally verified `ghcr.io/yingsuiai/direxio-product-agent:agent-mvp` image, and restarting only `product-agent`.
- App-upload bridge is still not proven on the deployed account. The current Flutter client uses REST-like methods but sends body-action requests to `/_p2p/query` and `/_p2p/command`; direct `_p2p/plugins/*` browser checks are not the real protocol. Product-agent can sync Prompt Skills from `agent_config.skills`; the remaining deploy step is a message-server build that forwards owner agent-room text messages to product-agent with saved official Agent plugin config.

## Loop 7 Checklist

- Add optional message-server bridge gated by `DIREXIO_PRODUCT_AGENT_URL`.
- Forward only owner text messages from the real `agent_room_id`; ignore gateway-marked replies to avoid loops.
- Include saved `io.dirextalk.agent` plugin config as `agent_config` so `skills` reaches product-agent.
- Write product-agent replies back as Matrix messages from local `@agent:<server>` with gateway markers.
- Verify with focused Go tests and `go build ./cmd/dirextalk-message-server`.
- Deploy the message-server bridge to `codex1.p2pagent.im` only after explicit restart approval.
- Save one Prompt Skill from the Flutter Agent plugin UI against a live account.
- Send one agent-room message that triggers that Prompt Skill.
- Confirm product-agent receives `agent_config.skills` through message-server, not only through direct smoke calls.
- Confirm the visible agent reply is concise and does not expose raw JSON.

Loop 7 progress:

- Added `p2p/product_agent_bridge.go` in `dirextalk-message-server`.
- Added `Config.ProductAgentURL` / `Config.ProductAgent`; production reads `DIREXIO_PRODUCT_AGENT_URL`.
- Updated `projectAgentRoomMessage` to dispatch product-agent `/v1/message-server/new-message` asynchronously for owner text in `agent_room_id`, so roomserver projection does not wait on model latency.
- Forwarded official Agent plugin config as `agent_config`.
- Gateway replies are sent through Matrix transport with `io.dirextalk.agent_gateway=true` and `io.dirextalk.gateway_source=product-agent`.
- Product-agent `direxio.agent_action_result.v1` outbound JSON is now converted by message-server into Matrix content fields: `io.direxio.agent_action_result` carries the card object, `io.direxio.agent_hide_body=true` hides fallback text in Direxio clients, and `body` stays a short human-readable summary for generic Matrix clients.
- Added focused tests for forwarding `agent_config.skills`, ignoring gateway-marked replies, keeping projection non-blocking, posting the correct product-agent HTTP route, preserving `agent_config.skills`, surfacing product-agent errors, and converting card JSON into structured Matrix card content.
- Added owner-only official Agent plugin memory bridge actions: `agent.memory.list`, `agent.memory.save`, and `agent.memory.delete`. They are invoked through the existing `plugins.invoke` envelope and proxy to product-agent memory APIs instead of exposing product-agent directly to Flutter.
- Added focused tests for the memory bridge actions, including action allowlist coverage, save/list/delete routing, missing product-agent bridge behavior, HTTP product-agent memory endpoints, and structured memory error propagation.
- Verified:
  - `gofmt`
  - `go test ./p2p -run "TestHTTPProductAgentClient|TestProductAgentClientFromConfig|TestProjectAgentRoomMessage|TestPluginConfigUpdateReappliesEnabledPluginRuntime|TestPluginModelProfileAPIKeyIsInvokeOnly" -count=1`
  - `go build ./cmd/dirextalk-message-server`
  - `git diff --check`
  - `docker compose -f docker-compose.p2p.yml config --quiet`
- Re-verified bridge card content conversion with `go test ./p2p -run "TestHTTPProductAgentClient|TestProductAgentClientFromConfig|TestProductAgentReplyMatrixPayload|TestProjectAgentRoomMessage|TestPluginConfigUpdateReappliesEnabledPluginRuntime|TestPluginModelProfileAPIKeyIsInvokeOnly" -count=1` and `go build ./cmd/dirextalk-message-server`.
- Full `go test ./p2p -count=1` is blocked by missing local PostgreSQL on `localhost:5432` and the Docker registry mirror resolving `docker.lms.run` incorrectly, so DB-backed tests could not start their required Postgres environment.
- Built a Linux `dirextalk-message-server-linux` binary locally for a possible remote hot-update test, but did not restart remote `message-server` because that is a human-controlled deployment action.
- Added `scripts/deploy-message-server-product-agent-bridge.ps1` as a guarded deployment harness for the optional message-server bridge.
- The script defaults to dry-run, resolves the local `dirextalk-message-server` repo and node PEM, and refuses to build/upload/restart unless `-Apply -IUnderstandThisRestartsMessageServer` are both supplied.
- Apply mode resolves Go from PATH or common Windows install locations, runs `scripts\verify-agent-memory-skill-loop.ps1` first by default, then builds/uploads/restarts. Use `-SkipLocalVerifier` only for an explicitly accepted emergency path; use `-SkipFlutterVerifier` only when Flutter is unavailable and product-agent/message-server checks are sufficient for that deploy attempt.
- The apply path builds a Linux amd64 message-server binary, uploads it to the node, backs up the currently running container binary, restarts only `message-server`, checks container health, verifies product-agent bridge markers in the deployed binary, verifies `DIREXIO_PRODUCT_AGENT_URL` is present in the container environment, and rolls back the binary if health or bridge verification fails.
- Verified the script with PowerShell parser validation and a dry-run against `codex1.p2pagent.im`; no remote restart was performed. Also built a temporary Linux amd64 message-server binary locally and confirmed it contains `/v1/message-server/new-message` and `io.direxio.agent_action_result`, the same bridge markers used by the remote Apply check.
- Added `scripts/verify-agent-memory-skill-loop.ps1` as the local loop verifier across product-agent, message-server, and Flutter.
- The verifier runs PowerShell parser checks for the agent harness scripts, product-agent typecheck, contract tests, build, memory/Prompt Skill smoke, message-server bridge tests, message-server build with cleanup of local build artifacts, and Flutter Agent card / Prompt Skill UI tests.
- Verified the local loop verifier end-to-end with `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-agent-memory-skill-loop.ps1`; it completed with `Agent memory + Prompt Skill local loop verification passed.`
- Strengthened the shared product-agent smoke runner with a config-only Prompt Skill case: it sends a `/v1/message-server/new-message` event whose new skill exists only in `agent_config.skills`, then verifies product-agent stores it and replies. The local smoke additionally asserts the fake gateway received the config-only skill prompt in the current turn.
- Re-verified the strengthened product-agent path with `npm run check`, `npm test`, and `npm run smoke:memory-skill`; the smoke reported `verified memory, prompt skill, config-only skill, and live model response`.
- Re-ran the full local loop verifier after the config-only smoke change: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-agent-memory-skill-loop.ps1` passed product-agent check/test/build/smoke, message-server bridge tests/build, and Flutter Agent card / Prompt Skill UI tests. Confirmed no local message-server build artifact remained and all three repos passed `git diff --check`.
- Re-ran the full local loop verifier after adding Card Prompt Skill upload coverage to the Flutter Agent plugin tests: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-agent-memory-skill-loop.ps1` passed product-agent typecheck/tests/build/smoke, message-server bridge tests/build, and Flutter card / Prompt Skill UI tests, including the `output_kind: agent_action_result` upload case.
- Re-ran the full local loop verifier after adding `PATCH /v1/agent/skills/:id` coverage: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-agent-memory-skill-loop.ps1` passed product-agent typecheck/tests/build/smoke, message-server bridge tests/build, and Flutter card / Prompt Skill UI tests. The product-agent contract now covers partial Prompt Skill update, snake_case update fields, validation failure, disabled skills disappearing from tools, and restart persistence.
- Re-ran the full local loop verifier after adding Flutter Prompt Skill edit UI coverage: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-agent-memory-skill-loop.ps1` passed product-agent typecheck/tests/build/smoke, message-server bridge tests/build, and Flutter card / Prompt Skill UI tests. The Flutter suite now proves users can create text Prompt Skills, create card-output Prompt Skills, and edit an existing Prompt Skill while preserving its id and disabled state.
- Added the `agent.memory.*` message-server tests to `scripts/verify-agent-memory-skill-loop.ps1` so the deployment verifier catches regressions in the App-callable memory bridge before any remote restart.
- Added Flutter provider coverage for saved Agent cards syncing to product-agent memory through `plugins.invoke` -> `agent.memory.save`, including the offline/unconfigured case where memory sync fails but the local Card Collection save remains intact.
- Re-ran the full local loop verifier after wiring Card Collection saves into the memory bridge: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-agent-memory-skill-loop.ps1` passed product-agent typecheck/tests/build/smoke, message-server product-agent bridge tests/build, and Flutter Agent card / Prompt Skill UI tests, including `agent_card_collection_provider_test.dart`.
- Strengthened `scripts/inspect-agent-stack-readiness.ps1` so read-only remote inspection reports message-server binary markers for the agent-room bridge, structured card bridge, memory plugin bridge, and `DIREXIO_PRODUCT_AGENT_URL`.
- Strengthened `scripts/deploy-message-server-product-agent-bridge.ps1` so Apply mode only passes when the deployed message-server binary contains `/v1/message-server/new-message`, `io.direxio.agent_action_result`, and `agent.memory.save`.
- Added `-RequireLatestMessageServerBridge` to `scripts/inspect-agent-stack-readiness.ps1`, so post-deploy readiness can fail automatically unless message-server has the latest agent-room, card, memory bridge markers and a configured `DIREXIO_PRODUCT_AGENT_URL`.
- Updated `scripts/deploy-message-server-product-agent-bridge.ps1` so successful Apply mode now runs the read-only readiness inspection with `-RequireLatestMessageServerBridge` after restarting `message-server`.
- Added `scripts/deploy-agent-memory-skill-stack.ps1` as the guarded full-stack deploy orchestrator. It defaults to dry-run, calls the product-agent and message-server deploy scripts in order, refuses Apply mode without both restart confirmations, and runs the combined `-RequireConfigOnlySmoke -RequireLatestMessageServerBridge` readiness gate after both deployments.
- Added `scripts/audit-agent-memory-skill-goal.ps1` as the non-mutating completion audit. It can run the local verifier, strong remote readiness, and manual live-App gate checks, returning non-zero until all completion gates are proven.
- Added `scripts/preflight-agent-memory-skill-deploy.ps1` as the single deploy-before-approval preflight. It runs the completion audit in `-ReportOnly` mode, requires `Local verifier=PASS`, records the current remote/live blocking gates, then runs the full-stack deploy orchestrator in dry-run mode.
- Strengthened `scripts/audit-agent-memory-skill-goal.ps1` so live App verified flags require a valid `-LiveAppEvidencePath` file with non-placeholder required field values and exact `- Result: PASS` lines for the Prompt Skill, Memory, and Card Rendering sections. Added `docs/superpowers/plans/2026-07-08-agent-memory-prompt-skill-live-app-evidence-template.md` as the durable evidence template for final completion.
- Fixed the shared argument helper in the new audit/deploy orchestration scripts so PowerShell's automatic `$args` variable does not swallow child-script parameters such as `-RequireConfigOnlySmoke`, `-RequireLatestMessageServerBridge`, custom repo paths, or `-KeyFile`.
- Updated `scripts/inspect-agent-stack-readiness.ps1` so strong readiness collects message-server bridge failures and product-agent config-only smoke failures in one read-only run, prints all available evidence, then exits non-zero if any required gate failed.
- Added optional `-SummaryJsonPath` support to `scripts/audit-agent-memory-skill-goal.ps1`, allowing completion audits to save gate results, blocking gate count, live-App flags, node, and timestamp as JSON evidence without changing the default non-mutating behavior.
- Updated `scripts/audit-agent-memory-skill-goal.ps1` so `-SummaryJsonPath` writes an initial `audit_finished=false` JSON snapshot before long-running gates, then overwrites it after each gate and at final summary.
- Added `scripts/test-agent-memory-skill-audit.ps1` and wired it into `scripts/verify-agent-memory-skill-loop.ps1`, so the local loop verifier proves that missing live evidence and empty-field PASS sections fail, while filled evidence passes the live App gates.
- Added `scripts/validate-agent-memory-skill-live-evidence.ps1` as a deployment-aftercare helper. It validates a filled live App evidence file against the same completion-audit live gate rules while intentionally skipping local verifier and remote readiness, so evidence formatting issues are caught before the final audit.
- Added `scripts/new-agent-memory-skill-live-evidence.ps1` as a deployment-aftercare helper. It creates a timestamped live App evidence working file from the template, pre-fills setup metadata when supplied, and refuses to overwrite existing evidence unless `-Force` is explicit.
- Added `scripts/test-agent-memory-skill-live-evidence-generator.ps1` and wired it into `scripts/verify-agent-memory-skill-loop.ps1`, so the local loop verifier proves the evidence generator creates pre-filled files, rejects accidental overwrite, and allows explicit `-Force` overwrite.
- Added `scripts/show-agent-memory-skill-status.ps1` as a read-only operator status helper. It finds the latest local audit JSON, prints the five completion gates, and recommends the next safe command based on whether local, remote, or live App gates are blocking.
- Added `scripts/test-agent-memory-skill-status.ps1` and wired it into `scripts/verify-agent-memory-skill-loop.ps1`, so the local loop verifier proves the status helper recommends preflight, local fixes, guarded deploy, live evidence workflow, or completion based on fixture gate states.
- Added `docs/superpowers/plans/2026-07-08-agent-memory-prompt-skill-live-app-checklist.md` so the three live App gates have concrete operator steps, pass criteria, completion command, and debug order.
- Added `docs/superpowers/plans/2026-07-08-agent-memory-prompt-skill-operator-runbook.md` as the shortest safe operator path from baseline audit to approved deploy, remote readiness, live App checklist, and final completion audit.
- Added agent harness PowerShell parser checks to `scripts/verify-agent-memory-skill-loop.ps1`; verified the parser gate with `-SkipProductAgent -SkipMessageServer -SkipFlutter`.
- Added `scripts/deploy-product-agent-image.ps1` as the guarded product-agent image update path for deployed nodes.
- The product-agent deploy script defaults to dry-run, resolves local repo paths and the node PEM, and refuses to build/upload/restart unless `-Apply -IUnderstandThisRestartsProductAgent` are both supplied.
- Apply mode runs the local verifier by default, builds a timestamped product-agent Docker image, runs the container memory/Prompt Skill smoke against that image, uploads it to the node with `docker save` / `docker load`, updates `.env` to use that image and the `product-agent` profile, restarts only `product-agent`, then runs the remote product-agent smoke. On remote smoke failure it restores the previous image selection when possible. After a successful remote smoke, Apply runs read-only readiness with `-RequireConfigOnlySmoke` so an old deployed image cannot pass the latest Prompt Skill acceptance gate.
- Verified the product-agent deploy script with PowerShell parser validation and a dry-run against `codex1.p2pagent.im`; no local image build, remote upload, or remote restart was performed.
- Added `scripts/inspect-agent-stack-readiness.ps1` as a read-only remote inspection tool. It redacts AI tokens, does not edit `.env`, does not upload files, and does not run `docker compose up` or `restart`.
- Fixed the readiness script so `docker compose exec` cannot consume the rest of the stdin-fed remote script.
- Ran the read-only readiness inspection against `codex1.p2pagent.im`: `message-server` is healthy, `product-agent` is running with `remote-smoke-runner=present`, `/v1/agent/actions` returns `direxio.agent_action_menu.v1`, `/v1/agent/tools` returns 13 tools, `memory_save=true`, and at least one `prompt_skill_*` tool is currently registered. This proves remote baseline readiness but not that the latest local code is deployed.
- Strengthened readiness inspection with optional `-RequireConfigOnlySmoke`. Default mode remains read-only reporting; require mode fails if `agent-config-only-smoke` is missing from the deployed product-agent runner. Parser validation, product-agent deploy dry-run, `git diff --check`, and a normal read-only inspection against `codex1.p2pagent.im` all passed; the node still reports `config-only-smoke=missing`, as expected before redeploy.
- Cleaned stale integration docs so the handoff now points to the current product-agent message routes, documents two-layer memory accurately, and records that the message-server bridge is implemented locally while remote deployment/live App verification remain pending.

Loop 7 remaining deployment gate:

- Human approves restarting remote `product-agent` on `codex1.p2pagent.im` with the latest product-agent image.
- Human approves restarting remote `message-server` on `codex1.p2pagent.im`.
- Follow `docs/superpowers/plans/2026-07-08-agent-memory-prompt-skill-operator-runbook.md`.
- Preferred single command: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-agent-memory-skill-stack.ps1 -NodeDomain codex1.p2pagent.im -Apply -IUnderstandThisRestartsProductAgent -IUnderstandThisRestartsMessageServer`.
- Manual fallback: run `scripts\deploy-product-agent-image.ps1` with `-Apply -IUnderstandThisRestartsProductAgent`, then run `scripts\deploy-message-server-product-agent-bridge.ps1` with `-Apply -IUnderstandThisRestartsMessageServer`.
- Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\inspect-agent-stack-readiness.ps1 -NodeDomain codex1.p2pagent.im -RequireConfigOnlySmoke -RequireLatestMessageServerBridge` after deployment to confirm both services are up and the latest product-agent/message-server gates pass.
- Confirm readiness reports `config-only-smoke=present`, `agent-card-bridge=present`, and `agent-memory-plugin-bridge=present`.
- Confirm the script runs the local verifier before remote upload; if it fails, stop and fix locally before deploying.
- Reopen the Flutter App against the deployed account.
- Complete `docs/superpowers/plans/2026-07-08-agent-memory-prompt-skill-live-app-checklist.md`.
- Save the filled live App evidence file at `docs/superpowers/plans/evidence/live-app-agent-memory-skill-evidence.md`.
- Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\validate-agent-memory-skill-live-evidence.ps1 -LiveAppEvidencePath docs\superpowers\plans\evidence\live-app-agent-memory-skill-evidence.md`.
- Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\audit-agent-memory-skill-goal.ps1 -NodeDomain codex1.p2pagent.im -LiveAppPromptSkillVerified -LiveAppMemoryVerified -LiveAppCardRenderingVerified -LiveAppEvidencePath docs\superpowers\plans\evidence\live-app-agent-memory-skill-evidence.md -SummaryJsonPath docs\superpowers\plans\evidence\postdeploy-agent-memory-skill-audit.json`.
