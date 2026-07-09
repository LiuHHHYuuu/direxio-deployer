import {
  createMemoryCapsule,
  createMoodCard,
  createPersonaCard
} from "../abilities/official-experience-abilities.js";
import type { AgentActionResult } from "../abilities/types.js";
import type { GatewayMessage } from "../types.js";
import type { AgentTool, AgentToolContext, AgentToolResult } from "./types.js";

export function createAgentExperienceTools(): AgentTool[] {
  return [
    {
      name: "create_persona_card",
      description: "Create a private Digital Persona Card from the current Direxio AI thread only.",
      manifest: {
        schema: "direxio.agent_tool.v1",
        name: "create_persona_card",
        title: "数字人格卡",
        description: "从当前 AI 对话生成一张简短私密人格卡。",
        category: "experience",
        source: "official",
        skillKind: "built_in",
        defaultEnabled: true,
        permissions: [
          { scope: "current_ai_thread", access: "read", required: true },
          { scope: "thread_memory", access: "read", required: false }
        ],
        inputSchema: experienceCardInputSchema(),
        outputKind: "agent_action_result",
        triggerExamples: ["生成数字人格卡", "总结我的互动风格", "Create a persona card"],
        shareable: true
      },
      run: async (input, context) => ok("create_persona_card", createPersonaCard(toolInput(input, context)))
    },
    {
      name: "create_memory_capsule",
      description: "Create a private Memory Capsule recap from the current Direxio AI thread only.",
      manifest: {
        schema: "direxio.agent_tool.v1",
        name: "create_memory_capsule",
        title: "记忆胶囊",
        description: "把当前 AI 对话整理成简短重点。",
        category: "experience",
        source: "official",
        skillKind: "built_in",
        defaultEnabled: true,
        permissions: [
          { scope: "current_ai_thread", access: "read", required: true },
          { scope: "thread_memory", access: "read", required: false }
        ],
        inputSchema: experienceCardInputSchema(),
        outputKind: "agent_action_result",
        triggerExamples: ["生成记忆胶囊", "总结这段对话", "Make a memory capsule"],
        shareable: true
      },
      run: async (input, context) => ok("create_memory_capsule", createMemoryCapsule(toolInput(input, context)))
    },
    {
      name: "create_mood_card",
      description: "Create a private Mood Card from the current Direxio AI thread only.",
      manifest: {
        schema: "direxio.agent_tool.v1",
        name: "create_mood_card",
        title: "今日状态卡",
        description: "生成一张简短状态卡。",
        category: "experience",
        source: "official",
        skillKind: "built_in",
        defaultEnabled: true,
        permissions: [
          { scope: "current_ai_thread", access: "read", required: true },
          { scope: "thread_memory", access: "read", required: false }
        ],
        inputSchema: experienceCardInputSchema(),
        outputKind: "agent_action_result",
        triggerExamples: ["生成今日状态卡", "看看我当前状态", "Make a mood card"],
        shareable: true
      },
      run: async (input, context) => ok("create_mood_card", createMoodCard(toolInput(input, context)))
    }
  ];
}

function experienceCardInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      focus: {
        type: "string",
        description: "Optional user-selected focus for the card."
      },
      limit: {
        type: "number",
        minimum: 1,
        maximum: 20,
        description: "Maximum current-thread messages to consider."
      }
    }
  };
}

function toolInput(input: Record<string, unknown>, context: AgentToolContext) {
  return {
    messages: uniqueMessages([...context.memory.recentMessages, ...context.payload.messages]),
    memory: context.memory,
    focus: stringInput(input.focus),
    limit: numberInput(input.limit, 12)
  };
}

function uniqueMessages(messages: GatewayMessage[]): GatewayMessage[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    const key = `${message.role}\u0000${message.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function numberInput(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(20, Math.floor(value))) : fallback;
}

function stringInput(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function ok(name: string, result: AgentActionResult): AgentToolResult {
  return {
    name,
    ok: true,
    content: JSON.stringify(result, null, 2)
  };
}
