import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentServiceApp } from "../lib/agent-service.js";
import type { FetchLike } from "../lib/types.js";
import { verifyState, writeState } from "./remote-smoke-runner.js";

interface SmokeApp {
  baseUrl: string;
  close(): Promise<void>;
}

const conversationId = "smoke-agent-room";

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});

/**
 * Function: Runs a local end-to-end smoke for persistent memory and Prompt Skill upload.
 * Inputs:
 * - Uses a temporary `DIREXIO_AGENT_DATA_DIR` and a fake hosted gateway.
 * Output:
 * - Logs a success line when memory survives restart and uploaded Prompt Skill triggers.
 * Side effects:
 * - Starts local Fastify HTTP listeners on ephemeral localhost ports.
 * - Writes then deletes a temporary product-agent data directory.
 * Errors:
 * - Throws assertion failures when any required step breaks.
 */
async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "direxio-agent-smoke-"));
  const gatewayPayloads: Record<string, unknown>[] = [];
  const fakeGateway: FetchLike = async (_url, init) => {
    gatewayPayloads.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({ reply: "smoke skill reply" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const first = await startSmokeApp(dataDir, fakeGateway);
    try {
      await writeState({
        baseUrl: first.baseUrl,
        smokeId: conversationId,
        phase: "write"
      });
    } finally {
      await first.close();
    }

    const second = await startSmokeApp(dataDir, fakeGateway);
    try {
      await verifyState({
        baseUrl: second.baseUrl,
        smokeId: conversationId,
        phase: "verify"
      });

      const gatewayContexts = gatewayPayloads.map(systemMessagesText).join("\n\n---\n\n");
      assert.match(gatewayContexts, /Prompt Skill: Remote Smoke Status Card/);
      assert.match(gatewayContexts, /remote smoke skill was loaded/);
      assert.match(gatewayContexts, /Please trigger remote-smoke/);
      assert.match(gatewayContexts, /Prompt Skill: Agent Config Only Smoke/);
      assert.match(gatewayContexts, /config-only Prompt Skill was loaded/);
      assert.match(gatewayContexts, /Please trigger agent-config-only-smoke/);
    } finally {
      await second.close();
    }

    console.log("product-agent memory+prompt-skill smoke ok");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/**
 * Function: Starts an agent-service instance with a persistent data directory.
 * Inputs:
 * - dataDir: Directory used as `DIREXIO_AGENT_DATA_DIR`.
 * - fetchImpl: Gateway fetch fake used by the runtime.
 * Output:
 * - Local base URL plus close function.
 * Side effects:
 * - Opens an ephemeral localhost HTTP port.
 * Errors:
 * - Propagates Fastify startup failures.
 */
async function startSmokeApp(dataDir: string, fetchImpl: FetchLike): Promise<SmokeApp> {
  const app = createAgentServiceApp({
    aiToken: "dxai_smoke",
    gatewayUrl: "http://gateway.smoke",
    env: {
      DIREXIO_AGENT_RUNTIME: "local",
      DIREXIO_AGENT_DATA_DIR: dataDir
    } as NodeJS.ProcessEnv,
    fetchImpl
  });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  return {
    baseUrl,
    close: () => app.close()
  };
}

function systemMessagesText(payload: unknown): string {
  const messages = asRecord(payload).messages;
  if (!Array.isArray(messages)) return "";
  return messages
    .map(asRecord)
    .filter((message) => message.role === "system")
    .map((message) => typeof message.content === "string" ? message.content : "")
    .filter(Boolean)
    .join("\n\n");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}
