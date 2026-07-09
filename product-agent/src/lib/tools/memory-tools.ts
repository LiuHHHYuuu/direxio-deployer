import type { AgentMemoryItemType } from "../memory/thread-memory.js";
import type { AgentTool, AgentToolManifest, AgentToolResult } from "./types.js";

export function createAgentMemoryTools(): AgentTool[] {
  return [
    {
      name: "memory_search",
      description: "Search relevant long-term memories saved for the current Direxio AI thread.",
      manifest: manifest({
        name: "memory_search",
        title: "Search memory",
        description: "Searches relevant long-term memories in the current AI conversation.",
        permissions: [{ scope: "thread_memory", access: "read", required: true }],
        inputSchema: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string", minLength: 1 },
            limit: { type: "number", minimum: 1, maximum: 20 }
          },
          additionalProperties: false
        }
      }),
      run: async (input, context) => {
        const query = stringInput(input.query);
        if (!query) return { name: "memory_search", ok: false, content: "Memory search query is required." };
        const items = await context.memoryStore?.searchMemories(context.payload.conversation_id, {
          query,
          limit: numberInput(input.limit, 5),
          fetchImpl: context.fetchImpl,
          env: context.env,
          event: context.event
        });
        return ok("memory_search", formatMemoryItems(items || []));
      }
    },
    {
      name: "memory_list",
      description: "List explicit memories saved for the current Direxio AI thread.",
      manifest: manifest({
        name: "memory_list",
        title: "List memory",
        description: "Lists explicit memories saved for the current AI conversation.",
        permissions: [{ scope: "thread_memory", access: "read", required: true }],
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", minimum: 1, maximum: 50 }
          },
          additionalProperties: false
        }
      }),
      run: async (input, context) => {
        const items = context.memoryStore?.listMemories(context.payload.conversation_id) ||
          context.memory.persistentMemories;
        const limit = numberInput(input.limit, 20);
        return ok("memory_list", formatMemoryItems(items.slice(-limit)));
      }
    },
    {
      name: "memory_save",
      description: "Save one explicit memory for the current Direxio AI thread when the user asks to remember it.",
      manifest: manifest({
        name: "memory_save",
        title: "Save memory",
        description: "Saves one explicit memory in the current AI conversation.",
        permissions: [{ scope: "thread_memory", access: "write", required: true }],
        inputSchema: {
          type: "object",
          required: ["text"],
          properties: {
            text: { type: "string", minLength: 1 },
            type: { type: "string", enum: ["fact", "preference", "card_memory", "skill_result", "thread_summary"] },
            tags: { type: "array", items: { type: "string" }, maxItems: 12 }
          },
          additionalProperties: false
        }
      }),
      run: async (input, context) => {
        if (!context.memoryStore) {
          return { name: "memory_save", ok: false, content: "Memory store is not available." };
        }
        const text = stringInput(input.text);
        if (!text) return { name: "memory_save", ok: false, content: "Memory text is required." };
        const item = context.memoryStore.saveMemory(context.payload.conversation_id, {
          text,
          type: memoryTypeInput(input.type),
          tags: stringListInput(input.tags)
        });
        return ok("memory_save", `Saved memory ${item.id}: ${item.text}`);
      }
    },
    {
      name: "memory_delete",
      description: "Delete one explicit memory from the current Direxio AI thread by id.",
      manifest: manifest({
        name: "memory_delete",
        title: "Delete memory",
        description: "Deletes one explicit memory from the current AI conversation.",
        permissions: [{ scope: "thread_memory", access: "write", required: true }],
        inputSchema: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", minLength: 1 }
          },
          additionalProperties: false
        }
      }),
      run: async (input, context) => {
        if (!context.memoryStore) {
          return { name: "memory_delete", ok: false, content: "Memory store is not available." };
        }
        const id = stringInput(input.id);
        if (!id) return { name: "memory_delete", ok: false, content: "Memory id is required." };
        const deleted = context.memoryStore.deleteMemory(context.payload.conversation_id, id);
        return ok("memory_delete", deleted ? `Deleted memory ${id}.` : `Memory ${id} was not found.`);
      }
    }
  ];
}

function formatMemoryItems(items: Array<{ id: string; type: string; text: string; tags: string[] }>): string {
  if (items.length === 0) return "No explicit memories have been saved yet.";
  return items
    .map((item) => `- ${item.id} [${item.type}]: ${item.text}${item.tags.length ? ` (${item.tags.join(", ")})` : ""}`)
    .join("\n");
}

function memoryTypeInput(value: unknown): AgentMemoryItemType | undefined {
  return value === "preference" ||
    value === "fact" ||
    value === "card_memory" ||
    value === "skill_result" ||
    value === "thread_summary"
    ? value
    : undefined;
}

function stringListInput(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function numberInput(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(50, Math.floor(value))) : fallback;
}

function stringInput(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function ok(name: string, content: string): AgentToolResult {
  return { name, ok: true, content };
}

function manifest(input: Omit<AgentToolManifest, "schema" | "category" | "source" | "skillKind" | "defaultEnabled" | "outputKind" | "shareable" | "triggerExamples">): AgentToolManifest {
  return {
    schema: "direxio.agent_tool.v1",
    ...input,
    category: "memory",
    source: "official",
    skillKind: "built_in",
    defaultEnabled: true,
    outputKind: "text",
    shareable: false,
    triggerExamples: []
  };
}
