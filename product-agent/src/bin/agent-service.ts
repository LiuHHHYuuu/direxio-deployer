#!/usr/bin/env node
import { createAgentServiceApp } from "../lib/agent-service.js";

const port = Number.parseInt(process.env.DIREXIO_AGENT_SERVICE_PORT || "8797", 10);
const host = process.env.DIREXIO_AGENT_SERVICE_HOST || "127.0.0.1";

try {
  const app = createAgentServiceApp();
  await app.listen({ port, host });
  console.log(JSON.stringify({ type: "agent-service-started", host, port }));
} catch (error) {
  console.error(JSON.stringify({
    type: "agent-service-start-failed",
    message: error instanceof Error ? error.message : "unknown error"
  }));
  process.exit(1);
}
