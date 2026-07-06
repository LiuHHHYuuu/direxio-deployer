import type { FetchLike } from "../types.js";
import { createLangChainAgentRuntime } from "./langchain-runtime.js";
import { createLocalAgentRuntime } from "./local-agent-runtime.js";
import type { AgentRuntime } from "./types.js";

export interface CreateAgentRuntimeOptions {
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

export function createAgentRuntime(options: CreateAgentRuntimeOptions = {}): AgentRuntime {
  const env = options.env || process.env;
  if (env.DIREXIO_AGENT_RUNTIME === "langchain") {
    return createLangChainAgentRuntime({
      fetchImpl: options.fetchImpl,
      env
    });
  }
  return createLocalAgentRuntime({
    fetchImpl: options.fetchImpl,
    env
  });
}
