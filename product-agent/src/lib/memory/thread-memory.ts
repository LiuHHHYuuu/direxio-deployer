import type { GatewayMessage } from "../types.js";

export interface ThreadMemorySnapshot {
  preferences: Record<string, string>;
  recentMessages: GatewayMessage[];
}

export interface ThreadMemoryStore {
  rememberMessages(conversationId: string, messages: GatewayMessage[]): void;
  rememberAssistantReply(conversationId: string, reply: string): void;
  snapshot(conversationId: string): ThreadMemorySnapshot;
}

interface ThreadMemoryState {
  preferences: Record<string, string>;
  recentMessages: GatewayMessage[];
}

export class InMemoryThreadMemoryStore implements ThreadMemoryStore {
  private readonly threads = new Map<string, ThreadMemoryState>();

  constructor(private readonly maxMessages = 20) {}

  rememberMessages(conversationId: string, messages: GatewayMessage[]): void {
    const state = this.stateFor(conversationId);
    for (const message of messages) {
      state.recentMessages.push(message);
      rememberPreferenceFromMessage(state.preferences, message);
    }
    trimMessages(state.recentMessages, this.maxMessages);
  }

  rememberAssistantReply(conversationId: string, reply: string): void {
    if (!reply.trim()) return;
    const state = this.stateFor(conversationId);
    state.recentMessages.push({ role: "assistant", content: reply.trim() });
    trimMessages(state.recentMessages, this.maxMessages);
  }

  snapshot(conversationId: string): ThreadMemorySnapshot {
    const state = this.stateFor(conversationId);
    return {
      preferences: { ...state.preferences },
      recentMessages: [...state.recentMessages]
    };
  }

  private stateFor(conversationId: string): ThreadMemoryState {
    const existing = this.threads.get(conversationId);
    if (existing) return existing;
    const created: ThreadMemoryState = {
      preferences: {},
      recentMessages: []
    };
    this.threads.set(conversationId, created);
    return created;
  }
}

function rememberPreferenceFromMessage(preferences: Record<string, string>, message: GatewayMessage): void {
  if (message.role !== "user") return;
  const content = message.content.toLowerCase();
  if (!content.includes("记住") && !content.includes("remember")) return;

  if (content.includes("简短") || content.includes("concise") || content.includes("short")) {
    preferences.response_style = "concise";
  }
  if (content.includes("详细") || content.includes("verbose") || content.includes("detailed")) {
    preferences.response_style = "detailed";
  }
  if (content.includes("中文") || content.includes("chinese")) {
    preferences.language = "zh-CN";
  }
  if (content.includes("english") || content.includes("英文")) {
    preferences.language = "en";
  }
}

function trimMessages(messages: GatewayMessage[], maxMessages: number): void {
  if (messages.length <= maxMessages) return;
  messages.splice(0, messages.length - maxMessages);
}
