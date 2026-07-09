# Agent Memory and Prompt Skill Live App Checklist

Operator runbook: `docs/superpowers/plans/2026-07-08-agent-memory-prompt-skill-operator-runbook.md`

Evidence template: `docs/superpowers/plans/2026-07-08-agent-memory-prompt-skill-live-app-evidence-template.md`

Use this checklist only after the deployed stack passes:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\inspect-agent-stack-readiness.ps1 -NodeDomain codex1.p2pagent.im -RequireConfigOnlySmoke -RequireLatestMessageServerBridge
```

This checklist verifies the live Flutter App/account behavior that cannot be
fully proven by local unit tests or remote container readiness.

## Setup

- Install a fresh App build before testing. For the local Flutter workspace,
  the debug APK path is usually
  `..\..\direxio-flutter\build\app\outputs\flutter-apk\app-debug.apk`.
  If a phone is connected with USB debugging enabled, install it with:

  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-latest-flutter-apk.ps1
  ```

  If `adb` or an Android emulator is unavailable on the operator machine,
  install this APK manually on the phone and record the APK timestamp/hash in
  the evidence file.
- Open the deployed Flutter App against the same node that passed readiness.
- Sign in as the node owner account.
- Confirm the official Agent plugin is installed, enabled, and has a valid model profile/API key.
- Confirm the normal Agent chat can send a plain message and receive a response.

Record these values before starting:

- Node/domain:
- Owner account:
- Agent room id, if visible from logs/debug tooling:
- App build/version:
- Evidence folder or notes file:

## Prompt Skill Path

Goal: prove a normal user can create a Prompt Skill in the App, and that the
skill reaches product-agent through message-server `agent_config.skills`.

1. Open `Me -> Plugin Management -> Agent`.
2. Tap `Create Prompt Skill`.
3. Create a small card-output Prompt Skill:
   - Title: `Status Capsule Smoke`
   - Description: `Return a short status capsule when asked for capsule smoke.`
   - Trigger/example text: `capsule smoke`
   - Output mode: card/action-result output
   - Prompt: `Return a concise Direxio action-result status capsule for the user's capsule smoke request. Keep summary under one sentence.`
4. Save the Agent plugin settings.
5. Open the normal Agent chat room.
6. Send: `capsule smoke`
7. Pass criteria:
   - The reply is influenced by the uploaded Prompt Skill.
   - No raw `direxio.prompt_skill.v1` config appears in chat.
   - No raw `direxio.agent_action_result.v1` JSON appears in chat.
   - If product-agent logs are inspected, the request contains the saved skill under `agent_config.skills`.

Evidence to record:

- Prompt Skill id:
- Trigger message sent:
- Visible reply summary:
- Evidence that product-agent received `agent_config.skills`:
- Screenshot or screen recording path:

## Memory Path

Goal: prove saving a structured Agent card persists locally and best-effort
syncs through `plugins.invoke -> agent.memory.save`.

1. In Agent chat, trigger a structured card/capsule reply.
2. Tap the card save action.
3. Open `Agent settings -> Card Collection`.
4. Confirm the saved card appears in the collection after leaving and reopening the page.
5. Pass criteria:
   - Local Card Collection shows the saved card.
   - The App remains usable if memory sync is slow.
   - Backend inspection or logs show `plugins.invoke` calling official Agent action `agent.memory.save`.
   - product-agent memory list for the same room/conversation includes a `card_memory` item.

Evidence to record:

- Saved card title/body:
- Conversation or room id used for memory:
- Evidence that `plugins.invoke -> agent.memory.save` ran:
- Product-agent memory item id:
- Screenshot or screen recording path:

## Card Rendering Path

Goal: prove the user sees a polished card/capsule, not transport JSON.

1. Send a message that triggers a structured Agent action result.
2. Inspect the visible Agent chat bubble.
3. Pass criteria:
   - The visible result is a card/capsule UI.
   - The visible body is short and readable.
   - Raw JSON is not displayed as a separate chat message.
   - Generic fallback text, if any, is a short summary only.

Evidence to record:

- Trigger message:
- Visible card title/body:
- Screenshot or screen recording path:
- Confirmation that no raw JSON bubble appeared:

## Completion Command

Before testing, create a live App evidence working file:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\new-agent-memory-skill-live-evidence.ps1 -NodeDomain codex1.p2pagent.im
```

After the three live App sections pass, fill that generated evidence file.
Each live section must have non-placeholder values for its required fields and
an exact `- Result: PASS` line. Validate the filled evidence file first,
replacing `<evidence-path>` with the path printed by the generator:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\validate-agent-memory-skill-live-evidence.ps1 -LiveAppEvidencePath <evidence-path>
```

Then run the final completion audit:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\audit-agent-memory-skill-goal.ps1 -NodeDomain codex1.p2pagent.im -LiveAppPromptSkillVerified -LiveAppMemoryVerified -LiveAppCardRenderingVerified -LiveAppEvidencePath <evidence-path>
```

The objective can be marked complete only if that audit exits successfully.
If the three live App flags are supplied without a valid evidence file, or if
any section is missing required field values or its exact `- Result: PASS`
line, the audit records the matching live gates as `FAIL`.

## Debug Order

1. If Prompt Skill does not trigger, inspect Agent plugin config first: saved `skills` must include `schema: direxio.prompt_skill.v1`.
2. If the skill is saved but product-agent ignores it, inspect message-server forwarding: product-agent requests must include `agent_config.skills`.
3. If the reply contains raw JSON, inspect message-server card mapping and Flutter card parser/hide-body handling.
4. If Card Collection saves locally but memory does not sync, inspect `plugins.invoke` for `agent.memory.save`, then message-server `DIREXIO_PRODUCT_AGENT_URL`, then product-agent `/v1/agent/memory`.
