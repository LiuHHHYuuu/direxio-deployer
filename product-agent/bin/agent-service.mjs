#!/usr/bin/env node
import { createServer } from "node:http";
import { createAgentServiceHandler } from "../lib/agent-service.mjs";

const port = Number.parseInt(process.env.DIREXIO_AGENT_SERVICE_PORT || "8797", 10);
const host = process.env.DIREXIO_AGENT_SERVICE_HOST || "127.0.0.1";

const server = createServer(createAgentServiceHandler());
server.listen(port, host, () => {
  console.log(JSON.stringify({ type: "agent-service-started", host, port }));
});
