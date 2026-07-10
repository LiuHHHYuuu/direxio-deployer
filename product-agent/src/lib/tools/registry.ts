import type { CurrentThreadMcpClient } from "../mcp/current-thread-mcp-client.js";
import type { ReadOnlyDirexioMcpClient } from "../mcp/read-only-direxio-mcp-client.js";
import type { PromptSkillStore } from "../skills/prompt-skill-store.js";
import { createDirexioReadOnlyTools } from "./direxio-tools.js";
import { createAgentMemoryTools } from "./memory-tools.js";
import { createPromptSkillTools } from "./prompt-skill-tools.js";
import type { AgentTool, AgentToolManifest } from "./types.js";

export interface AgentToolRegistryOptions {
  currentThreadMcpClient?: CurrentThreadMcpClient;
  readOnlyMcpClient?: ReadOnlyDirexioMcpClient;
  promptSkillStore?: PromptSkillStore;
}

export interface AgentToolRegistry {
  tools: AgentTool[];
  manifests: AgentToolManifest[];
  byName: Map<string, AgentTool>;
}

export function createAgentToolRegistry(options: AgentToolRegistryOptions = {}): AgentToolRegistry {
  const tools = [
    ...createDirexioReadOnlyTools({
      currentThreadMcpClient: options.currentThreadMcpClient,
      readOnlyMcpClient: options.readOnlyMcpClient
    }),
    ...createAgentMemoryTools(),
    ...createPromptSkillTools(options.promptSkillStore?.listSkills() || [])
  ];
  return {
    tools,
    manifests: tools.map((item) => item.manifest),
    byName: new Map(tools.map((item) => [item.name, item]))
  };
}
