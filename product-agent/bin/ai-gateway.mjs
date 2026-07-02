#!/usr/bin/env node
import { createServer } from "node:http";
import { createAiGatewayHandler } from "../lib/ai-gateway.mjs";

const port = Number.parseInt(process.env.DIREXIO_AI_GATEWAY_PORT || "8787", 10);
const host = process.env.DIREXIO_AI_GATEWAY_HOST || "127.0.0.1";

const server = createServer(createAiGatewayHandler());
server.listen(port, host, () => {
  console.log(JSON.stringify({ type: "ai-gateway-started", host, port }));
});
