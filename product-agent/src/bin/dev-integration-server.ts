#!/usr/bin/env node
import Fastify from "fastify";
import { createAgentServiceApp, type AgentServiceOptions } from "../lib/agent-service.js";
import type { FetchLike } from "../lib/types.js";

export interface DevIntegrationAppOptions extends Pick<AgentServiceOptions, "gatewayUrl" | "aiToken"> {
  fetchImpl?: FetchLike;
}

interface InjectableAgentService {
  inject(options: {
    method: "POST";
    url: string;
    headers: Record<string, string>;
    payload: string;
  }): Promise<{
    statusCode: number;
    json(): unknown;
  }>;
}

const port = Number.parseInt(process.env.DIREXIO_DEV_INTEGRATION_PORT || "8798", 10);
const host = process.env.DIREXIO_DEV_INTEGRATION_HOST || "127.0.0.1";

export async function createDevIntegrationApp(options: DevIntegrationAppOptions = {}) {
  const app = Fastify({ logger: false });
  const agentService = createAgentServiceApp({
    gatewayUrl: options.gatewayUrl,
    aiToken: options.aiToken,
    fetchImpl: options.fetchImpl
  });

  await agentService.ready();

  app.post("/dev/message-server/new-message", async (request, reply) => {
    // This dev-only endpoint uses Fastify inject so local testing exercises the
    // exact agent-service route without requiring a second process or port.
    const injectable = agentService as unknown as InjectableAgentService;
    const response = await injectable.inject({
      method: "POST",
      url: "/v1/message-server/new-message",
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify(request.body ?? {})
    });
    return reply.status(response.statusCode).send(response.json());
  });

  app.addHook("onClose", async () => {
    await agentService.close();
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  try {
    const app = await createDevIntegrationApp();
    await app.listen({ host, port });
    console.log(JSON.stringify({ type: "dev-integration-server-started", host, port }));
  } catch (error) {
    console.error(JSON.stringify({
      type: "dev-integration-server-start-failed",
      message: error instanceof Error ? error.message : "unknown error"
    }));
    process.exit(1);
  }
}
