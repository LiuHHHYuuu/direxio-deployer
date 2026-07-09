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
    title: "数字人格卡",
    shortTitle: "人格卡",
    description: "总结最近互动风格。",
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
    title: "记忆胶囊",
    shortTitle: "记忆",
    description: "整理当前重点。",
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
    title: "今日状态卡",
    shortTitle: "状态",
    description: "生成简短状态。",
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
  const memory = memoryHighlights(input.memory);
  return baseResult({
    action: "persona_card",
    title: "数字人格卡",
    summary: `${toneLabel(tone)}，关注${themes[0]}。`,
    points: compact([
      `重点：${themes[0]}`,
      `风格：${toneLabel(tone)}`,
      memory[0] ? `记忆：${memory[0]}` : preference ? `记忆：${preference}` : "记忆：暂无"
    ]),
    nextActions: ["生成分享版"]
  });
}

export function createMemoryCapsule(input: ExperienceAbilityInput): AgentActionResult {
  const messages = recentUserMessages(input);
  const text = combinedText(messages);
  const themes = detectThemes(text);
  const memory = memoryHighlights(input.memory);
  return baseResult({
    action: "memory_capsule",
    title: "记忆胶囊",
    summary: input.focus ? `围绕${input.focus}整理。` : `主要围绕${themes[0]}。`,
    points: compact([
      `主题：${themes[0]}`,
      `信号：${themes[1] || "产品推进"}`,
      ...(memory[0] ? [`记忆：${memory[0]}`] : []),
      `范围：${messages.length} 条`
    ]),
    nextActions: ["保存为私密记忆"]
  });
}

export function createMoodCard(input: ExperienceAbilityInput): AgentActionResult {
  const messages = recentUserMessages(input);
  const text = combinedText(messages);
  const tone = detectTone(text);
  const signals = moodSignals(text);
  const memory = memoryHighlights(input.memory);
  return baseResult({
    action: "mood_card",
    title: "今日状态卡",
    summary: `当前状态：${toneLabel(tone)}。`,
    points: compact([
      signals[0] || "稳定推进",
      signals[1] || "适合做一个小下一步",
      ...(memory[0] ? [`记忆：${memory[0]}`] : [])
    ]),
    nextActions: ["换个更轻的版本"]
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
  addTheme(themes, text, "Agent 搭建", ["agent", "langchain", "mcp", "tool", "runtime", "gateway"]);
  addTheme(themes, text, "隐私边界", ["privacy", "private", "permission", "authorized", "consent", "隐私", "权限"]);
  addTheme(themes, text, "自部署", ["deploy", "docker", "server", "ec2", "ghcr", "部署", "服务器"]);
  addTheme(themes, text, "移动端体验", ["mobile", "app", "friend", "chat", "message", "移动", "聊天"]);
  addTheme(themes, text, "Web3 身份", ["web3", "wallet", "identity", "ens", "did", "xmtp", "lens"]);
  addTheme(themes, text, "边做边学", ["learn", "teach", "explain", "syntax", "code", "test", "学习", "讲解"]);
  return themes.length ? themes.slice(0, 3) : ["产品探索", "持续推进", "下一步"];
}

function addTheme(themes: string[], text: string, theme: string, needles: string[]): void {
  if (needles.some((needle) => text.includes(needle))) themes.push(theme);
}

function detectTone(text: string): string {
  if (containsAny(text, ["privacy", "permission", "safe", "risk", "隐私", "权限", "风险"])) return "careful";
  if (containsAny(text, ["continue", "implement", "build", "ship", "test", "继续", "实现", "测试"])) return "builder";
  if (containsAny(text, ["how", "why", "explain", "teach", "learn", "?", "如何", "为什么", "讲解", "学习"])) return "curious";
  if (containsAny(text, ["future", "direction", "web3", "upgrade", "未来", "方向", "升级"])) return "exploratory";
  return "focused";
}

function moodSignals(text: string): string[] {
  const signals = [];
  if (containsAny(text, ["continue", "build", "implement", "test", "继续", "实现", "测试"])) signals.push("执行感强");
  if (containsAny(text, ["how", "explain", "teach", "learn", "如何", "讲解", "学习"])) signals.push("学习状态在线");
  if (containsAny(text, ["privacy", "safe", "permission", "隐私", "权限"])) signals.push("在意信任边界");
  if (containsAny(text, ["future", "direction", "upgrade", "未来", "方向", "升级"])) signals.push("在想 MVP 之后");
  return signals.length ? signals : ["产品感稳定"];
}

function memoryHighlights(memory: ThreadMemorySnapshot): string[] {
  const candidates = [
    ...(memory.relevantMemories || []).map((item) => item.text),
    ...Object.entries(memory.preferences).map(([key, value]) => `${key}=${value}`),
    ...memory.persistentMemories.map((item) => item.text)
  ];
  const seen = new Set<string>();
  return candidates
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 2);
}

function firstPreference(memory: ThreadMemorySnapshot): string {
  const entry = Object.entries(memory.preferences)[0];
  return entry ? `${entry[0]}=${entry[1]}` : "";
}

function compact(values: string[]): string[] {
  return values
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((value) => value.length > 36 ? `${value.slice(0, 33)}...` : value);
}

function containsAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function toneLabel(tone: string): string {
  switch (tone) {
    case "careful":
      return "谨慎";
    case "builder":
      return "推进中";
    case "curious":
      return "好奇";
    case "exploratory":
      return "探索中";
    default:
      return "专注";
  }
}
