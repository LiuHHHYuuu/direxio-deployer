import type { GatewayMessage } from "./types.js";
import type { AgentActionName } from "./abilities/types.js";

/**
 * Internal product-agent conversation type for messages intentionally
 * addressed to the built-in Direxio AI friend. The message-server adapter also
 * accepts the native message-server product kind "agent" and normalizes it.
 */
export const DIREXIO_AI_CONVERSATION_TYPE = "direxio_ai" as const;

/**
 * Event shape that message-server sends to agent-service after a user posts a
 * message in the Direxio AI conversation.
 */
export interface AgentMessageEvent {
  /** Internal normalized type; other conversation types are ignored. */
  conversation_type: typeof DIREXIO_AI_CONVERSATION_TYPE;

  /** Stable self-hosted node id used by ai-gateway for quota and audit scope. */
  node_id: string;

  /** Conversation where the AI reply should be written back. */
  conversation_id: string;

  /** Recent messages from the AI conversation only, ordered oldest to newest. */
  messages: AgentConversationMessage[];

  /** Optional structured action selected from the Direxio AI action menu. */
  agent_action?: AgentActionRequest;

  /** Optional task hint, for example "chat", "rewrite", "translate", or "summarize". */
  task?: string;

  /** Optional model hint. The hosted gateway can ignore unsupported values. */
  model?: string;

  /** User-selected external text. This is ignored unless context_authorized is true. */
  selected_context?: string;

  /** Explicit consent bit for selected_context. It must never default to true. */
  context_authorized?: boolean;
}

/**
 * Minimal message shape accepted by agent-service. A later integration can add
 * ids and timestamps, but content is the only required model input for the MVP.
 */
export interface AgentConversationMessage {
  /** Structured action message created by the in-app action menu. */
  type?: "agent_action";

  /** Action name when type is "agent_action". */
  action?: AgentActionName;

  /** Optional action focus shown in the result. */
  focus?: string;

  /** Optional limit for current-thread messages considered by the action. */
  limit?: number;

  /** "agent" is normalized to assistant; every other unknown sender becomes user. */
  sender?: "user" | "agent" | "assistant";

  /** OpenAI-compatible role; when present it takes precedence over sender. */
  role?: GatewayMessage["role"];

  /** Text that the user or AI sent inside the AI conversation. */
  content?: string;
}

export interface AgentActionRequest {
  type: "agent_action";
  action: AgentActionName;
  focus?: string;
  limit?: number;
}

/**
 * Response shape returned by agent-service when the hosted gateway succeeds.
 * message-server should persist outbound_message as the AI reply.
 */
export interface AgentMessageSuccess {
  reply: string;
  outbound_message: {
    conversation_id: string;
    content: string;
  };
}

/**
 * Response shape returned when agent-service intentionally skips an event.
 * message-server can treat this as a no-op, not as a failed user message.
 */
export interface AgentMessageIgnored {
  ignored: true;
  reason: "not_ai_conversation";
}

/**
 * User-safe error shape. These codes are meant for product UI mapping and must
 * not expose provider keys, AI tokens, or raw upstream error bodies.
 */
export interface AgentMessageFailure {
  error: {
    code:
      | "setup_needed"
      | "hosted_ai_auth_failed"
      | "quota_exceeded"
      | "temporary_unavailable"
      | "invalid_json"
      | "invalid_agent_event"
      | "bad_gateway_response"
      | "bad_gateway_request"
      | "internal_error";
    message: string;
  };
}

export type AgentMessageResponse = AgentMessageSuccess | AgentMessageIgnored | AgentMessageFailure;
