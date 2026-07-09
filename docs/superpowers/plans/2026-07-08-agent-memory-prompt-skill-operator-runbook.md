# Agent Memory and Prompt Skill Operator Runbook

This runbook is the shortest safe path from the current local implementation to
a deployed, live-App-verified Agent memory + Prompt Skill release.

Related docs:

- Plan: `docs/superpowers/plans/2026-07-08-agent-memory-prompt-skill-loop-plan.md`
- Live App checklist: `docs/superpowers/plans/2026-07-08-agent-memory-prompt-skill-live-app-checklist.md`
- Live App evidence template: `docs/superpowers/plans/2026-07-08-agent-memory-prompt-skill-live-app-evidence-template.md`
- Latest baseline evidence: `docs/superpowers/plans/evidence/20260708-170701-agent-memory-skill-preflight-audit.json`

## 1. Confirm Current Baseline

Show the latest known gate status:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\show-agent-memory-skill-status.ps1 -NodeDomain codex1.p2pagent.im
```

Run the preflight first. It runs the completion audit in `-ReportOnly` mode,
requires the local verifier to pass, and then runs the full-stack deploy
orchestrator in dry-run mode:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\preflight-agent-memory-skill-deploy.ps1 -NodeDomain codex1.p2pagent.im
```

Expected before deployment:

- `Local verifier` is `PASS`.
- `Remote readiness` is `FAIL`.
- `Live App Prompt Skill path`, `Live App memory path`, and `Live App card rendering path` are `PENDING`.
- Full-stack deploy dry-run is `PASS`.

Stop if preflight fails.

## 2. Human Approval Boundary

Do not deploy until the operator explicitly accepts both restarts:

- `product-agent` restart.
- `message-server` restart.

These are human-controlled production actions.

## 3. Deploy Full Agent Stack

After approval, run the guarded full-stack deploy:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-agent-memory-skill-stack.ps1 -NodeDomain codex1.p2pagent.im -Apply -IUnderstandThisRestartsProductAgent -IUnderstandThisRestartsMessageServer
```

The script must:

- Run the local verifier unless explicitly skipped.
- Deploy/restart product-agent and run product-agent smoke/readiness.
- Deploy/restart message-server and run message-server bridge readiness.
- Run combined readiness with `-RequireConfigOnlySmoke -RequireLatestMessageServerBridge`.

Stop if any step fails.

## 4. Confirm Remote Readiness

Run the combined read-only gate again:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\inspect-agent-stack-readiness.ps1 -NodeDomain codex1.p2pagent.im -RequireConfigOnlySmoke -RequireLatestMessageServerBridge
```

Pass criteria:

- `config-only-smoke=present`
- `agent-card-bridge=present`
- `agent-memory-plugin-bridge=present`
- `product-agent-url-env=present`

## 5. Verify Live App Behavior

Install the current debug APK on a USB-debugging-enabled Android phone when
available:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-latest-flutter-apk.ps1
```

If no authorized device is connected, install the APK manually from the Flutter
workspace and record the APK path, timestamp, and hash in the evidence file.

Create a timestamped evidence working file:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\new-agent-memory-skill-live-evidence.ps1 -NodeDomain codex1.p2pagent.im
```

Then complete:

```text
docs/superpowers/plans/2026-07-08-agent-memory-prompt-skill-live-app-checklist.md
```

Use the generated evidence path from the command output. If you intentionally
want the stable path used in the examples, create it explicitly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\new-agent-memory-skill-live-evidence.ps1 -OutputPath docs\superpowers\plans\evidence\live-app-agent-memory-skill-evidence.md -NodeDomain codex1.p2pagent.im
```

Each live App evidence section must fill the required fields with
non-placeholder values and contain an exact `- Result: PASS` line.

Validate the filled evidence file before running the final audit:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\validate-agent-memory-skill-live-evidence.ps1 -LiveAppEvidencePath <evidence-path>
```

This validation checks only the live App evidence fields. It intentionally skips
local verifier and remote readiness so evidence formatting problems are caught
before the final completion audit.

Pass criteria:

- Prompt Skill can be created/edited in the deployed App and triggered from Agent chat.
- Saving a structured Agent card persists locally and syncs through `agent.memory.save`.
- Agent card/capsule output renders as UI, not raw JSON.

## 6. Final Completion Audit

After remote readiness and live App checks pass:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\audit-agent-memory-skill-goal.ps1 -NodeDomain codex1.p2pagent.im -LiveAppPromptSkillVerified -LiveAppMemoryVerified -LiveAppCardRenderingVerified -LiveAppEvidencePath <evidence-path> -SummaryJsonPath docs\superpowers\plans\evidence\postdeploy-agent-memory-skill-audit.json
```

The objective can be marked complete only if this command exits successfully
and the JSON has:

- `audit_finished=true`
- `complete=true`
- `blocking_gate_count=0`

## 7. If It Fails

- Local verifier fails: fix local code/tests before deployment.
- Remote readiness fails: inspect product-agent image freshness, message-server bridge markers, and `DIREXIO_PRODUCT_AGENT_URL`.
- Live Prompt Skill fails: inspect Agent plugin `skills` config and message-server `agent_config.skills` forwarding.
- Live memory sync fails: inspect Flutter `plugins.invoke`, message-server `agent.memory.save`, and product-agent `/v1/agent/memory`.
- Raw JSON appears: inspect product-agent structured outbound content, message-server Matrix mapping, and Flutter hide-body/card parser.
