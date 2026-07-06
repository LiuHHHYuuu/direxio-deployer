import { BaseChatModel, type BaseChatModelCallOptions, type BaseChatModelParams, type BindToolsInput } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { z } from "zod";
import { callHostedGateway, type HostedGatewayFailure } from "../hosted-gateway-client.js";
import type {
  FetchLike,
  GatewayChatRequest,
  GatewayMessage,
  GatewayToolCall,
  GatewayToolDefinition
} from "../types.js";

export interface DirexioGatewayChatModelFields extends BaseChatModelParams {
  gatewayUrl: string;
  aiToken: string;
  nodeId: string;
  conversationId: string;
  task?: string;
  model?: string;
  fetchImpl?: FetchLike;
  tools?: BindToolsInput[];
  toolChoice?: "auto" | "none";
}

export class DirexioGatewayChatModelError extends Error {
  constructor(readonly failure: HostedGatewayFailure) {
    super(`${failure.error.code}: ${failure.error.message}`);
    this.name = "DirexioGatewayChatModelError";
  }
}

export class DirexioGatewayChatModel extends BaseChatModel<BaseChatModelCallOptions> {
  private readonly gatewayUrl: string;
  private readonly aiToken: string;
  private readonly nodeId: string;
  private readonly conversationId: string;
  private readonly task: string;
  private readonly model: string;
  private readonly fetchImpl: FetchLike;
  private readonly tools: BindToolsInput[];
  private readonly toolChoice?: "auto" | "none";

  constructor(fields: DirexioGatewayChatModelFields) {
    super(fields);
    this.gatewayUrl = fields.gatewayUrl;
    this.aiToken = fields.aiToken;
    this.nodeId = fields.nodeId;
    this.conversationId = fields.conversationId;
    this.task = fields.task || "chat";
    this.model = fields.model || "default";
    this.fetchImpl = fields.fetchImpl || globalThis.fetch;
    this.tools = fields.tools || [];
    this.toolChoice = fields.toolChoice;
  }

  _llmType(): string {
    return "direxio_gateway_chat_model";
  }

  bindTools(tools: BindToolsInput[], kwargs?: Partial<BaseChatModelCallOptions>): DirexioGatewayChatModel {
    return new DirexioGatewayChatModel({
      gatewayUrl: this.gatewayUrl,
      aiToken: this.aiToken,
      nodeId: this.nodeId,
      conversationId: this.conversationId,
      task: this.task,
      model: this.model,
      fetchImpl: this.fetchImpl,
      tools,
      toolChoice: normalizeToolChoice(kwargs?.tool_choice)
    });
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const payload: GatewayChatRequest = {
      node_id: this.nodeId,
      conversation_id: this.conversationId,
      task: this.task,
      model: this.model,
      messages: messages.map(toGatewayMessage),
      ...(this.tools.length ? { tools: this.tools.map(toolToGatewayDefinition), tool_choice: this.toolChoice || "auto" } : {})
    };
    const result = await callHostedGateway({
      gatewayUrl: this.gatewayUrl,
      aiToken: this.aiToken,
      payload,
      fetchImpl: this.fetchImpl
    });
    if (!result.ok) {
      throw new DirexioGatewayChatModelError(result);
    }
    const toolCalls = (result.tool_calls || []).map(toLangChainToolCall);
    const message = new AIMessage({
      content: result.reply,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {})
    });
    return {
      generations: [
        {
          text: result.reply,
          message
        }
      ],
      llmOutput: {
        tool_calls: result.tool_calls || []
      }
    };
  }
}

function toGatewayMessage(message: BaseMessage): GatewayMessage {
  const type = message.type;
  const content = messageContent(message);
  if (type === "system") {
    return { role: "system", content };
  }
  if (type === "ai") {
    const toolCalls = normalizeLangChainToolCalls((message as unknown as { tool_calls?: unknown }).tool_calls);
    return {
      role: "assistant",
      content,
      ...(message.name ? { name: message.name } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {})
    };
  }
  if (type === "tool") {
    const toolCallId = (message as unknown as { tool_call_id?: unknown }).tool_call_id;
    return {
      role: "tool",
      content,
      ...(typeof toolCallId === "string" && toolCallId ? { tool_call_id: toolCallId } : {}),
      ...(message.name ? { name: message.name } : {})
    };
  }
  return {
    role: "user",
    content,
    ...(message.name ? { name: message.name } : {})
  };
}

function toolToGatewayDefinition(tool: BindToolsInput): GatewayToolDefinition {
  const record = asRecord(tool);
  const functionRecord = asRecord(record.function);
  if (record.type === "function" && typeof functionRecord.name === "string") {
    return {
      type: "function",
      function: {
        name: functionRecord.name,
        ...(typeof functionRecord.description === "string" ? { description: functionRecord.description } : {}),
        parameters: asRecord(functionRecord.parameters)
      }
    };
  }

  const name = stringProperty(record.name) || "unknown_tool";
  const description = stringProperty(record.description);
  return {
    type: "function",
    function: {
      name,
      ...(description ? { description } : {}),
      parameters: schemaToJsonSchema(record.schema)
    }
  };
}

function schemaToJsonSchema(schema: unknown): Record<string, unknown> {
  if (!schema) {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  try {
    return asRecord(z.toJSONSchema(schema as never));
  } catch {
    return asRecord(schema);
  }
}

function toLangChainToolCall(toolCall: GatewayToolCall): GatewayToolCall {
  return {
    type: "tool_call",
    id: toolCall.id,
    name: toolCall.name,
    args: toolCall.args || {}
  };
}

function normalizeLangChainToolCalls(value: unknown): GatewayToolCall[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((toolCall) => {
      const item = asRecord(toolCall);
      const id = stringProperty(item.id);
      const name = stringProperty(item.name);
      if (!id || !name) return null;
      return {
        type: "tool_call" as const,
        id,
        name,
        args: asRecord(item.args)
      };
    })
    .filter((toolCall): toolCall is GatewayToolCall => Boolean(toolCall));
}

function normalizeToolChoice(value: unknown): "auto" | "none" | undefined {
  return value === "auto" || value === "none" ? value : undefined;
}

function messageContent(message: BaseMessage): string {
  if (typeof message.content === "string") return message.content;
  if (message.text) return message.text;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      if (typeof part === "string") return part;
      const record = asRecord(part);
      return stringProperty(record.text) || JSON.stringify(record);
    })
    .join("");
}

function stringProperty(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}
