import type { ThreadMemorySnapshot } from "../memory/thread-memory.js";
import type { GatewayMessage } from "../types.js";
import type {
  AgentAbilityManifest,
  AgentActionMenu,
  AgentActionMenuItem,
  AgentActionResult
} from "./types.js";

export interface ExperienceAbilityInput {
  messages: GatewayMessage[];
  memory: ThreadMemorySnapshot;
  focus?: string;
  limit?: number;
}

export const officialExperienceAbilityManifests: AgentAbilityManifest[] = [
  {
    id: "persona-card",
    action: "persona_card",
    title: "Digital Persona Card",
    shortTitle: "Persona",
    description: "Create a private, compact persona summary from the current AI thread.",
    permissions: [
      { scope: "current_ai_thread", access: "read", required: true },
      { scope: "thread_memory", access: "read", required: false }
    ],
    defaultVisibility: "private",
    outputKind: "agent_action_result"
  },
  {
    id: "memory-capsule",
    action: "memory_capsule",
    title: "Memory Capsule",
    shortTitle: "Memory",
    description: "Create a short private recap from the current AI thread.",
    permissions: [
      { scope: "current_ai_thread", access: "read", required: true },
      { scope: "thread_memory", access: "read", required: false }
    ],
    defaultVisibility: "private",
    outputKind: "agent_action_result"
  },
  {
    id: "mood-card",
    action: "mood_card",
    title: "Mood Card",
    shortTitle: "Mood",
    description: "Create a short private mood snapshot from the current AI thread.",
    permissions: [
      { scope: "current_ai_thread", access: "read", required: true },
      { scope: "thread_memory", access: "read", required: false }
    ],
    defaultVisibility: "private",
    outputKind: "agent_action_result"
  }
];

export function createAgentActionMenu(): AgentActionMenu {
  return {
    schema: "direxio.agent_action_menu.v1",
    title: "Direxio AI actions",
    items: officialExperienceAbilityManifests.map(toMenuItem)
  };
}

export function createPersonaCard(input: ExperienceAbilityInput): AgentActionResult {
  const messages = recentUserMessages(input);
  const text = combinedText(messages);
  const themes = detectThemes(text);
  const tone = detectTone(text);
  const preference = firstPreference(input.memory);
  return baseResult({
    action: "persona_card",
    title: "Digital Persona Card",
    summary: `You are showing ${tone} energy around ${themes[0]}.`,
    points: compact([
      `Main focus: ${themes[0]}`,
      `Style: ${tone}`,
      preference ? `Remembered: ${preference}` : "Memory: no explicit preference yet"
    ]),
    nextActions: ["Generate share version"]
  });
}

export function createMemoryCapsule(input: ExperienceAbilityInput): AgentActionResult {
  const messages = recentUserMessages(input);
  const text = combinedText(messages);
  const themes = detectThemes(text);
  return baseResult({
    action: "memory_capsule",
    title: "Memory Capsule",
    summary: input.focus ? `A short recap around ${input.focus}.` : `This thread is mostly about ${themes[0]}.`,
    points: compact([
      `Theme: ${themes[0]}`,
      `Signal: ${themes[1] || "focused product thinking"}`,
      `Scope: ${messages.length} current-thread messages`
    ]),
    nextActions: ["Save private note"]
  });
}

export function createMoodCard(input: ExperienceAbilityInput): AgentActionResult {
  const messages = recentUserMessages(input);
  const text = combinedText(messages);
  const tone = detectTone(text);
  const signals = moodSignals(text);
  return baseResult({
    action: "mood_card",
    title: "Mood Card",
    summary: `Current mood reads as ${tone}.`,
    points: compact([
      signals[0] || "Steady and focused",
      signals[1] || "Good moment for a small next step",
      "Private until you choose to share"
    ]),
    nextActions: ["Make it calmer"]
  });
}

function toMenuItem(manifest: AgentAbilityManifest): AgentActionMenuItem {
  return {
    action: manifest.action,
    title: manifest.shortTitle,
    subtitle: manifest.description,
    icon: iconForAction(manifest.action)
  };
}

function iconForAction(action: AgentActionResult["action"]): AgentActionMenuItem["icon"] {
  if (action === "persona_card") return "user";
  if (action === "memory_capsule") return "archive";
  return "sparkles";
}

function baseResult(result: Omit<AgentActionResult, "schema" | "privacy">): AgentActionResult {
  return {
    schema: "direxio.agent_action_result.v1",
    ...result,
    points: compact(result.points).slice(0, 3),
    nextActions: compact(result.nextActions).slice(0, 2),
    privacy: {
      sourceScope: "current_ai_thread",
      defaultVisibility: "private",
      shareRequiresUserAction: true
    }
  };
}

function recentUserMessages(input: ExperienceAbilityInput): GatewayMessage[] {
  const limit = typeof input.limit === "number" && Number.isFinite(input.limit)
    ? Math.max(1, Math.min(12, Math.floor(input.limit)))
    : 8;
  return uniqueMessages(input.messages)
    .filter((message) => message.role === "user")
    .slice(-limit);
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

function combinedText(messages: GatewayMessage[]): string {
  return messages.map((message) => message.content).join("\n").toLowerCase();
}

function detectThemes(text: string): string[] {
  const themes: string[] = [];
  addTheme(themes, text, "agent building", ["agent", "langchain", "mcp", "tool", "runtime", "gateway"]);
  addTheme(themes, text, "privacy boundaries", ["privacy", "private", "permission", "authorized", "consent"]);
  addTheme(themes, text, "self-hosted deployment", ["deploy", "docker", "server", "ec2", "ghcr"]);
  addTheme(themes, text, "mobile social experience", ["mobile", "app", "friend", "chat", "message"]);
  addTheme(themes, text, "web3 identity", ["web3", "wallet", "identity", "ens", "did", "xmtp", "lens"]);
  addTheme(themes, text, "learning by building", ["learn", "teach", "explain", "syntax", "code", "test"]);
  return themes.length ? themes.slice(0, 3) : ["product exploration", "implementation momentum", "clear next steps"];
}

function addTheme(themes: string[], text: string, theme: string, needles: string[]): void {
  if (needles.some((needle) => text.includes(needle))) themes.push(theme);
}

function detectTone(text: string): string {
  if (containsAny(text, ["privacy", "permission", "safe", "risk"])) return "careful";
  if (containsAny(text, ["continue", "implement", "build", "ship", "test"])) return "builder";
  if (containsAny(text, ["how", "why", "explain", "teach", "learn", "?"])) return "curious";
  if (containsAny(text, ["future", "direction", "web3", "upgrade"])) return "exploratory";
  return "focused";
}

function moodSignals(text: string): string[] {
  const signals = [];
  if (containsAny(text, ["continue", "build", "implement", "test"])) signals.push("Execution energy is high");
  if (containsAny(text, ["how", "explain", "teach", "learn"])) signals.push("Learning mode is active");
  if (containsAny(text, ["privacy", "safe", "permission"])) signals.push("Trust boundaries matter");
  if (containsAny(text, ["future", "direction", "upgrade"])) signals.push("Thinking beyond the MVP");
  return signals.length ? signals : ["Steady product focus"];
}

function firstPreference(memory: ThreadMemorySnapshot): string {
  const entry = Object.entries(memory.preferences)[0];
  return entry ? `${entry[0]}=${entry[1]}` : "";
}

function compact(values: string[]): string[] {
  return values
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((value) => value.length > 96 ? `${value.slice(0, 93)}...` : value);
}

function containsAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}
