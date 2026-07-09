import type { FetchLike } from "../types.js";
import type { ThreadMemoryStore } from "../memory/thread-memory.js";
import { createDefaultThreadMemoryStore } from "../memory/store-factory.js";
import type { PromptSkillStore } from "../skills/prompt-skill-store.js";
import { createLangChainAgentRuntime } from "./langchain-runtime.js";
import { createLocalAgentRuntime } from "./local-agent-runtime.js";
import type { AgentRuntime } from "./types.js";

export interface CreateAgentRuntimeOptions {
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  memoryStore?: ThreadMemoryStore;
  promptSkillStore?: PromptSkillStore;
}

export function createAgentRuntime(options: CreateAgentRuntimeOptions = {}): AgentRuntime {
  const env = options.env || process.env;
  const memoryStore = options.memoryStore || createDefaultThreadMemoryStore(env);
  if (env.DIREXIO_AGENT_RUNTIME === "local") {
    return createLocalAgentRuntime({
      fetchImpl: options.fetchImpl,
      env,
      memoryStore,
      promptSkillStore: options.promptSkillStore
    });
  }
  return createLangChainAgentRuntime({
    fetchImpl: options.fetchImpl,
    env,
    memoryStore,
    promptSkillStore: options.promptSkillStore
  });
}
