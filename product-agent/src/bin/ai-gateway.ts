#!/usr/bin/env node
import { createAiGatewayApp } from "../lib/ai-gateway.js";

const port = Number.parseInt(process.env.DIREXIO_AI_GATEWAY_PORT || "8787", 10);
const host = process.env.DIREXIO_AI_GATEWAY_HOST || "127.0.0.1";

try {
  const app = createAiGatewayApp();
  await app.listen({ port, host });
  console.log(JSON.stringify({ type: "ai-gateway-started", host, port }));
} catch (error) {
  console.error(JSON.stringify({
    type: "ai-gateway-start-failed",
    message: error instanceof Error ? error.message : "unknown error"
  }));
  process.exit(1);
}
