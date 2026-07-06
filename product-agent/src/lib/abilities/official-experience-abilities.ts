import type { ThreadMemorySnapshot } from "../memory/thread-memory.js";
import type { GatewayMessage } from "../types.js";
import type { AgentAbilityManifest, AgentExperienceCard } from "./types.js";

export interface ExperienceAbilityInput {
  messages: GatewayMessage[];
  memory: ThreadMemorySnapshot;
  focus?: string;
  limit?: number;
}

export const officialExperienceAbilityManifests: AgentAbilityManifest[] = [
  {
    id: "persona-card",
    title: "Persona Card",
    description: "Summarize the user's current style, interests, and builder energy from the current AI thread.",
    permissions: [
      { scope: "current_ai_thread", access: "read", required: true },
      { scope: "thread_memory", access: "read", required: false }
    ],
    defaultVisibility: "private",
    outputKind: "experience_card"
  },
  {
    id: "memory-capsule",
    title: "Memory Capsule",
    description: "Turn the current AI thread into a compact private recap with decisions, themes, and next prompts.",
    permissions: [
      { scope: "current_ai_thread", access: "read", required: true },
      { scope: "thread_memory", access: "read", required: false }
    ],
    defaultVisibility: "private",
    outputKind: "experience_card"
  },
  {
    id: "mood-card",
    title: "Mood Card",
    description: "Create a lightweight private mood snapshot from the current AI thread.",
    permissions: [
      { scope: "current_ai_thread", access: "read", required: true },
      { scope: "thread_memory", access: "read", required: false }
    ],
    defaultVisibility: "private",
    outputKind: "experience_card"
  }
];

export function createPersonaCard(input: ExperienceAbilityInput): AgentExperienceCard {
  const messages = recentUserMessages(input);
  const text = combinedText(messages);
  const themes = detectThemes(text);
  const tone = detectTone(text);
  const preferences = Object.entries(input.memory.preferences).map(([key, value]) => `${key}: ${value}`);
  return baseCard({
    cardType: "persona_card",
    title: "Digital Persona Card",
    subtitle: input.focus ? `Focus: ${input.focus}` : `${tone} with ${themes[0] || "curious builder"} energy`,
    highlights: [
      `Primary signal: ${themes[0] || "curious builder"}`,
      `Interaction style: ${tone}`,
      preferences.length ? `Remembered preference: ${preferences[0]}` : "No long-term preference has been saved yet."
    ],
    sections: [
      { label: "Themes", value: themes },
      { label: "Recent signals", value: pickRepresentativeLines(messages, 3) },
      { label: "Remembered preferences", value: preferences.length ? preferences : ["No explicit preferences yet."] }
    ],
    prompts: [
      "Turn this into a shareable profile summary.",
      "Make this card warmer and more personal.",
      "Suggest one small next action based on this persona."
    ]
  });
}

export function createMemoryCapsule(input: ExperienceAbilityInput): AgentExperienceCard {
  const messages = recentUserMessages(input);
  const text = combinedText(messages);
  const themes = detectThemes(text);
  return baseCard({
    cardType: "memory_capsule",
    title: "Memory Capsule",
    subtitle: input.focus ? `Thread recap for ${input.focus}` : "A private recap of the current AI thread",
    highlights: [
      `Main theme: ${themes[0] || "ongoing product thinking"}`,
      `Message sample size: ${messages.length}`,
      "Scope: current AI thread only"
    ],
    sections: [
      { label: "What mattered", value: themes },
      { label: "Key moments", value: pickRepresentativeLines(messages, 4) },
      { label: "Suggested next prompts", value: nextPromptsForThemes(themes) }
    ],
    prompts: [
      "Write this as a weekly recap.",
      "Extract decisions and unresolved questions.",
      "Save this as a private memory note."
    ]
  });
}

export function createMoodCard(input: ExperienceAbilityInput): AgentExperienceCard {
  const messages = recentUserMessages(input);
  const text = combinedText(messages);
  const tone = detectTone(text);
  const themes = detectThemes(text);
  return baseCard({
    cardType: "mood_card",
    title: "Mood Card",
    subtitle: input.focus ? `Mood around ${input.focus}` : `Current tone: ${tone}`,
    highlights: [
      `Tone: ${tone}`,
      `Anchor: ${themes[0] || "focused conversation"}`,
      "Visibility: private until the user chooses to share"
    ],
    sections: [
      { label: "Mood signals", value: moodSignals(text) },
      { label: "Recent lines", value: pickRepresentativeLines(messages, 3) },
      { label: "Gentle follow-ups", value: nextPromptsForThemes(themes).slice(0, 2) }
    ],
    prompts: [
      "Make this into a short status card.",
      "Give me a calmer version.",
      "Suggest one message I can send next."
    ]
  });
}

function baseCard(card: Omit<AgentExperienceCard, "schema" | "privacy">): AgentExperienceCard {
  return {
    schema: "direxio.agent_experience_card.v1",
    ...card,
    privacy: {
      sourceScope: "current_ai_thread",
      defaultVisibility: "private",
      shareRequiresUserAction: true
    }
  };
}

function recentUserMessages(input: ExperienceAbilityInput): GatewayMessage[] {
  const limit = typeof input.limit === "number" && Number.isFinite(input.limit)
    ? Math.max(1, Math.min(20, Math.floor(input.limit)))
    : 12;
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
  addTheme(themes, text, "agent builder", ["agent", "langchain", "mcp", "tool", "runtime", "gateway"]);
  addTheme(themes, text, "privacy-aware product thinking", ["privacy", "private", "permission", "authorized", "consent"]);
  addTheme(themes, text, "self-hosted infrastructure", ["deploy", "docker", "server", "ec2", "ghcr", "gateway"]);
  addTheme(themes, text, "mobile social experience", ["mobile", "app", "friend", "chat", "message"]);
  addTheme(themes, text, "web3 identity and portability", ["web3", "wallet", "identity", "ens", "did", "xmtp", "lens", "farcaster"]);
  addTheme(themes, text, "learning through implementation", ["learn", "teach", "explain", "syntax", "code", "test"]);
  return themes.length ? themes.slice(0, 5) : ["curious builder", "product exploration", "implementation momentum"];
}

function addTheme(themes: string[], text: string, theme: string, needles: string[]): void {
  if (needles.some((needle) => text.includes(needle))) themes.push(theme);
}

function detectTone(text: string): string {
  if (containsAny(text, ["how", "why", "explain", "teach", "learn", "?"])) return "curious and learning";
  if (containsAny(text, ["continue", "implement", "build", "ship", "test"])) return "decisive and building";
  if (containsAny(text, ["privacy", "permission", "safe", "risk"])) return "careful and privacy-aware";
  if (containsAny(text, ["future", "direction", "web3", "upgrade"])) return "strategic and exploratory";
  return "focused and conversational";
}

function moodSignals(text: string): string[] {
  const signals = [];
  if (containsAny(text, ["continue", "build", "implement", "test"])) signals.push("Execution energy is high.");
  if (containsAny(text, ["how", "explain", "teach", "learn"])) signals.push("Learning intent is active.");
  if (containsAny(text, ["privacy", "safe", "permission"])) signals.push("Trust and boundaries matter in this moment.");
  if (containsAny(text, ["future", "direction", "upgrade"])) signals.push("The conversation is looking beyond the MVP.");
  return signals.length ? signals : ["The thread feels steady, focused, and exploratory."];
}

function nextPromptsForThemes(themes: string[]): string[] {
  const prompts = themes.map((theme) => `What is the smallest next step for ${theme}?`);
  return prompts.length ? prompts.slice(0, 3) : [
    "What should we try next?",
    "What should stay private?",
    "What would make this feel delightful?"
  ];
}

function pickRepresentativeLines(messages: GatewayMessage[], limit: number): string[] {
  const lines = messages
    .map((message) => normalizeLine(message.content))
    .filter(Boolean)
    .slice(-limit);
  return lines.length ? lines : ["No recent user lines were available."];
}

function normalizeLine(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function containsAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}
