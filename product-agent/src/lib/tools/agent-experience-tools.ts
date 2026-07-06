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
      run: async (input, context) => ok("create_persona_card", createPersonaCard(toolInput(input, context)))
    },
    {
      name: "create_memory_capsule",
      description: "Create a private Memory Capsule recap from the current Direxio AI thread only.",
      run: async (input, context) => ok("create_memory_capsule", createMemoryCapsule(toolInput(input, context)))
    },
    {
      name: "create_mood_card",
      description: "Create a private Mood Card from the current Direxio AI thread only.",
      run: async (input, context) => ok("create_mood_card", createMoodCard(toolInput(input, context)))
    }
  ];
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
