import type { ThreadMemorySnapshot } from "../memory/thread-memory.js";
import type { AgentTool, AgentToolResult } from "../tools/types.js";

export type TaskPlanMode = "direct" | "external_evidence" | "clarify";

export interface TaskPlan {
  mode: TaskPlanMode;
  requiredCapabilities: string[];
  searchQuery?: string;
  missingFields?: string[];
  reason: string;
}

export interface ToolEvidence {
  toolName: string;
  capabilities: string[];
  ok: boolean;
  content: string;
  sources: string[];
}

export interface CompletionValidation {
  ok: boolean;
  reason: string;
}

const PUBLIC_WEB_CAPABILITY = "public_web";
const FRESH_INFORMATION_CAPABILITY = "fresh_information";
const LOCATION_MEMORY_KEY = "profile.location.city";

/** Plans only high-confidence external-evidence requirements; other turns stay on the normal agent path. */
export function planTask(userMessage: string, memory: ThreadMemorySnapshot): TaskPlan {
  const text = userMessage.trim();
  if (!text || !requiresExternalEvidence(text)) {
    return {
      mode: "direct",
      requiredCapabilities: [],
      reason: "No high-confidence external evidence requirement was detected."
    };
  }

  const capabilities = explicitPublicWebRequest(text)
    ? [PUBLIC_WEB_CAPABILITY, FRESH_INFORMATION_CAPABILITY]
    : [FRESH_INFORMATION_CAPABILITY];
  if (isWeatherLookup(text) && !hasExplicitLocation(text)) {
    const locationMemory = ownerLocationMemory(memory);
    if (!locationMemory) {
      return {
        mode: "clarify",
        requiredCapabilities: capabilities,
        missingFields: ["location"],
        reason: "Current weather information requires a location."
      };
    }
    return {
      mode: "external_evidence",
      requiredCapabilities: capabilities,
      searchQuery: `${text}\nKnown user location: ${locationMemory}`,
      reason: "The answer requires current public information and location was resolved from owner memory."
    };
  }

  return {
    mode: "external_evidence",
    requiredCapabilities: capabilities,
    searchQuery: text,
    reason: "The answer requires current public information."
  };
}

export class EvidenceLedger {
  private readonly evidence: ToolEvidence[] = [];

  record(tool: AgentTool, result: AgentToolResult): ToolEvidence {
    const item: ToolEvidence = {
      toolName: tool.name,
      capabilities: [...(tool.manifest.capabilities || [])],
      ok: result.ok && hasUsableToolContent(result.content),
      content: result.content.trim(),
      sources: [...(result.sources || [])]
    };
    this.evidence.push(item);
    return item;
  }

  satisfies(capability: string): boolean {
    return this.evidence.some((item) => item.ok && item.capabilities.includes(capability));
  }

  items(): ToolEvidence[] {
    return this.evidence.map((item) => ({ ...item, capabilities: [...item.capabilities], sources: [...item.sources] }));
  }

  promptContext(): string {
    const successful = this.evidence.filter((item) => item.ok);
    if (successful.length === 0) return "";
    return [
      "Verified external evidence for this turn:",
      ...successful.map((item) => [
        `Tool: ${item.toolName}`,
        item.content,
        ...(item.sources.length ? [`Sources: ${item.sources.join(", ")}`] : [])
      ].join("\n"))
    ].join("\n\n");
  }
}

export function findToolForCapabilities(tools: AgentTool[], requiredCapabilities: string[]): AgentTool | undefined {
  return tools.find((tool) => requiredCapabilities.every((capability) =>
    tool.manifest.capabilities?.includes(capability)
  )) || tools.find((tool) => requiredCapabilities.some((capability) =>
    tool.manifest.capabilities?.includes(capability)
  ));
}

export function validateCompletion(
  plan: TaskPlan,
  ledger: EvidenceLedger,
  reply: string
): CompletionValidation {
  const missingCapability = plan.requiredCapabilities.find((capability) => !ledger.satisfies(capability));
  if (missingCapability) {
    return { ok: false, reason: `missing_evidence:${missingCapability}` };
  }
  if (!reply.trim()) {
    return { ok: false, reason: "empty_answer" };
  }
  if (isEmptyPromise(reply)) {
    return { ok: false, reason: "empty_promise" };
  }
  if (ledger.items().some((item) => item.ok) && claimsSearchUnavailable(reply)) {
    return { ok: false, reason: "contradicts_available_evidence" };
  }
  return { ok: true, reason: "complete" };
}

export function clarificationReply(userMessage: string): string {
  return containsCjk(userMessage)
    ? "你想查询哪个城市或地区？"
    : "Which city or area should I use?";
}

export function externalEvidenceFailureReply(userMessage: string, noResults = false): string {
  if (containsCjk(userMessage)) {
    return noResults ? "暂时没有查到可靠结果，请换个说法再试。" : "暂时无法联网查询，请稍后再试。";
  }
  return noResults
    ? "I could not find a reliable result. Please try a different query."
    : "I cannot reach web search right now. Please try again later.";
}

export function completionRetryInstruction(reason: string, ledger: EvidenceLedger): string {
  return [
    "The previous draft failed the Direxio completion check.",
    `Failure: ${reason}.`,
    "Answer the user's request now using the verified evidence below.",
    "Do not promise future work, ask the user to wait, or expose tool JSON.",
    ledger.promptContext()
  ].filter(Boolean).join("\n\n");
}

function requiresExternalEvidence(text: string): boolean {
  return explicitPublicWebRequest(text) ||
    isWeatherLookup(text) ||
    /(?:新闻|热搜|价格|票价|多少钱|汇率|股价|行情|比分|赛程|路况|航班|news|price|exchange\s+rate|stock\s+price|score|schedule|traffic|flight)/iu.test(text) ||
    /(?:最新|今日|今天|明天|后天|本周|本月|latest|current|today|tomorrow|this\s+week)/iu.test(text);
}

function explicitPublicWebRequest(text: string): boolean {
  return /(?:联网|上网|网上|互联网|网页搜索|搜索网页|web\s+search|search\s+(?:the\s+)?web|look\s+up\s+online|browse\s+(?:the\s+)?web)/iu.test(text);
}

function isWeatherLookup(text: string): boolean {
  return /(?:天气|气温|天气预报|weather|forecast|temperature)/iu.test(text);
}

function hasExplicitLocation(text: string): boolean {
  if (/(?:天气|气温|预报).{0,8}(?:在|in)\s*[\p{L}\p{N}][\p{L}\p{N}\s.-]{1,40}/iu.test(text)) return true;
  if (/(?:weather|forecast|temperature)\s+(?:in|for)\s+[\p{L}\p{N}][\p{L}\p{N}\s.-]{1,40}/iu.test(text)) return true;
  const chinesePrefix = text.match(/([\p{Script=Han}]{2,24})(?:今天|今日|明天|后天)?(?:的)?(?:天气|气温|天气预报)/u)?.[1] || "";
  const candidate = chinesePrefix
    .replace(/^(?:请问|请帮我|帮我|查一下|查查|看看|我想知道)/u, "")
    .replace(/(?:今天|今日|明天|后天)$/u, "")
    .trim();
  return candidate.length >= 2;
}

function ownerLocationMemory(memory: ThreadMemorySnapshot): string {
  return memory.persistentMemories
    .find((item) => !item.deletedAt && item.scope === "owner" && item.key === LOCATION_MEMORY_KEY)
    ?.text.trim() || "";
}

function hasUsableToolContent(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  return normalized.length > 0 &&
    !normalized.includes("no useful web search result") &&
    !normalized.includes("no search results") &&
    !normalized.includes("search failed") &&
    !normalized.includes("temporarily unavailable");
}

function isEmptyPromise(reply: string): boolean {
  const normalized = reply.replace(/[\s.!?,，。！？…]+/gu, " ").trim().toLowerCase();
  if (normalized.length > 100) return false;
  return /^(?:好的\s*)?(?:我(?:来|会|将)?(?:帮你)?(?:查|查询|搜索|看看)|正在(?:查|查询|搜索)|稍等|请稍等|let me (?:check|search|look)|i(?:'ll| will) (?:check|search|look)|checking now)/iu.test(normalized);
}

function claimsSearchUnavailable(reply: string): boolean {
  return /(?:无法|不能|没法).{0,12}(?:联网|搜索|查询)|(?:cannot|can't|unable to).{0,20}(?:search|browse|access the web)/iu.test(reply);
}

function containsCjk(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value);
}
