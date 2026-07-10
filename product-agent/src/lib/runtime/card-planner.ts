import type { AgentActionName } from "../abilities/types.js";
import type { GatewayMessage } from "../types.js";

export type CardState = "momentum" | "milestone" | "calm" | "reflection" | "identity";

export interface CardDecision {
  action: AgentActionName;
  state: CardState;
  confidence: number;
  proactive: boolean;
  reason: string;
}

export class ProactiveCardGate {
  private readonly lastGeneratedAt = new Map<string, number>();

  constructor(private readonly cooldownMs: number) {}

  allow(conversationId: string, now = Date.now()): boolean {
    const last = this.lastGeneratedAt.get(conversationId);
    return last === undefined || now - last >= this.cooldownMs;
  }

  mark(conversationId: string, now = Date.now()): void {
    this.lastGeneratedAt.set(conversationId, now);
  }
}

export function planCardDecision(options: {
  messages: GatewayMessage[];
  requestedAction?: AgentActionName;
  allowProactive: boolean;
}): CardDecision | null {
  const latest = [...options.messages].reverse().find((message) => message.role === "user")?.content.trim() || "";
  const context = options.messages
    .filter((message) => message.role === "user")
    .slice(-8)
    .map((message) => message.content)
    .join("\n");
  const state = detectCardState(context);

  if (options.requestedAction) {
    return {
      action: options.requestedAction,
      state: stateForAction(options.requestedAction, state),
      confidence: 1,
      proactive: false,
      reason: "The user explicitly selected a card action."
    };
  }

  if (isGenericCardRequest(latest)) {
    return {
      action: actionForContext(context),
      state,
      confidence: 0.95,
      proactive: false,
      reason: "The user explicitly requested a card and left the card type to the agent."
    };
  }

  if (!options.allowProactive || !latest || /[?？]/u.test(latest)) return null;
  if (isMilestone(latest)) {
    return {
      action: "mood_card",
      state: "milestone",
      confidence: 0.94,
      proactive: true,
      reason: "A concrete milestone is worth reflecting back visually."
    };
  }
  if (isOverloaded(latest)) {
    return {
      action: "mood_card",
      state: "calm",
      confidence: 0.95,
      proactive: true,
      reason: "The user expressed a strong sustained-load signal that benefits from a compact supportive card."
    };
  }
  if (isDurableDecision(latest)) {
    return {
      action: "memory_capsule",
      state: "reflection",
      confidence: 0.88,
      proactive: true,
      reason: "The user stated a concrete decision worth summarizing."
    };
  }
  return null;
}

function actionForContext(text: string): AgentActionName {
  if (isOverloaded(text) || isMilestone(text)) return "mood_card";
  if (isDurableDecision(text) || /(?:总结|回顾|复盘|recap|summary|decision)/iu.test(text)) return "memory_capsule";
  if (/(?:我是什么样|我的风格|人格|persona|personality|interaction style)/iu.test(text)) return "persona_card";
  return "mood_card";
}

function detectCardState(text: string): CardState {
  if (isOverloaded(text)) return "calm";
  if (isMilestone(text)) return "milestone";
  if (/(?:我是什么样|我的风格|人格|persona|personality)/iu.test(text)) return "identity";
  if (isDurableDecision(text) || /(?:总结|回顾|复盘|reflect|recap)/iu.test(text)) return "reflection";
  return "momentum";
}

function stateForAction(action: AgentActionName, detected: CardState): CardState {
  if (action === "persona_card") return "identity";
  if (action === "memory_capsule") return "reflection";
  return detected;
}

function isGenericCardRequest(text: string): boolean {
  return /(?:给我|帮我|生成|做|来)(?:一张|一个)?(?:智能)?卡片|(?:make|create|generate)\s+(?:me\s+)?a\s+card/iu.test(text);
}

function isMilestone(text: string): boolean {
  return /(?:终于|已经)?(?:完成了|搞定了|跑通了|上线了|发布了|通过了)|\b(?:finished|completed|shipped|launched|passed)\b/iu.test(text);
}

function isOverloaded(text: string): boolean {
  return /(?:撑不住|压力很大|太累了|好累|焦虑|崩溃|不知所措|喘不过气)|\b(?:overwhelmed|burned out|burnt out|anxious|exhausted)\b/iu.test(text);
}

function isDurableDecision(text: string): boolean {
  return /(?:我们|我)?(?:决定了|确定方案|达成共识|最终选择|下一步是)|\b(?:we decided|i decided|final decision|next step is)\b/iu.test(text);
}
