import type {
  AgentConversationMessage,
  AgentMessageEvent
} from "./integration-contract.js";
import {
  agentActionToMessageContent,
  normalizeAgentAction
} from "./abilities/action-protocol.js";
import { DIREXIO_AI_CONVERSATION_TYPE } from "./integration-contract.js";

/**
 * Minimal message-server event shape used by the product-agent handoff layer.
 * Real message-server code can keep its own richer internal type and map into
 * this adapter at the event boundary.
 */
export interface MessageServerNewMessageEvent {
  node_id: string;
  /** Product conversation id or Matrix room id for the Direxio agent room. */
  conversation_id?: string;
  /** Native message-server payloads can pass the Matrix room id directly. */
  room_id?: string;
  conversation_type: string;
  sender_id?: string;
  sender_kind?: "user" | "agent" | "assistant" | "system";
  content?: string;
  agent_action?: unknown;
  recent_messages?: AgentConversationMessage[];
  task?: string;
  model?: string;
  selected_context?: string;
  context_authorized?: boolean;
}

export interface AdapterIgnored {
  ignored: true;
  reason: "not_ai_conversation" | "empty_message";
}

export type AdapterResult = AgentMessageEvent | AdapterIgnored;

const MESSAGE_SERVER_AGENT_CONVERSATION_TYPE = "agent";

/**
 * Converts a message-server "new message" event into the product-agent request.
 *
 * Privacy invariant: only Direxio AI conversations become AgentMessageEvent.
 * Human DMs, group rooms, and unknown conversation types are ignored here.
 * User-selected external context is passed through, but agent-service still
 * requires context_authorized === true before it forwards that text upstream.
 */
export function toAgentMessageEvent(event: MessageServerNewMessageEvent): AdapterResult {
  if (!isDirexioAiConversationType(event.conversation_type)) {
    return { ignored: true, reason: "not_ai_conversation" };
  }

  const action = normalizeAgentAction(event.agent_action);
  const content = action ? agentActionToMessageContent(action) : (event.content || "").trim();
  if (!content) {
    return { ignored: true, reason: "empty_message" };
  }

  const messages = normalizeRecentMessages(event.recent_messages, {
    sender: event.sender_kind === "agent" || event.sender_kind === "assistant" ? "assistant" : "user",
    content
  });

  return {
    conversation_type: DIREXIO_AI_CONVERSATION_TYPE,
    node_id: event.node_id,
    conversation_id: conversationIdForMessageServerEvent(event),
    messages,
    ...(action ? { agent_action: action } : {}),
    task: event.task,
    model: event.model,
    selected_context: event.selected_context,
    context_authorized: event.context_authorized
  };
}

function isDirexioAiConversationType(value: string): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === DIREXIO_AI_CONVERSATION_TYPE || normalized === MESSAGE_SERVER_AGENT_CONVERSATION_TYPE;
}

function conversationIdForMessageServerEvent(event: MessageServerNewMessageEvent): string {
  const conversationId = event.conversation_id?.trim();
  if (conversationId) {
    return conversationId;
  }
  return event.room_id?.trim() || "";
}

function normalizeRecentMessages(
  recentMessages: AgentConversationMessage[] | undefined,
  currentMessage: AgentConversationMessage
): AgentConversationMessage[] {
  const normalized = Array.isArray(recentMessages)
    ? recentMessages.filter((message) => typeof message.content === "string" && message.content.trim())
    : [];
  return [...normalized, currentMessage];
}
